// MaRa renderer API release 6 — stable Canvas capture + render-only rate limit
import cors from 'cors';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import multer from 'multer';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = trimTrailingSlash(process.env.FRONTEND_URL || 'https://slidemara.vercel.app');

/*
  Prefer PUBLIC_BASE_URL, but fall back to Railway's automatically supplied
  public domain. This prevents the headless Vercel renderer from receiving an
  empty `api` query parameter when PUBLIC_BASE_URL was not manually added.
*/
const PUBLIC_BASE_URL = normalizePublicBaseUrl(
  process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '',
);
const JOB_ROOT = process.env.JOB_ROOT || '/tmp/mara-render-jobs';
const MAX_UPLOAD_MB = clampNumber(process.env.MAX_UPLOAD_MB, 300, 20, 900);
const MAX_VIDEO_SECONDS = clampNumber(process.env.MAX_VIDEO_SECONDS, 180, 10, 600);
const MAX_ASSETS = clampNumber(process.env.MAX_ASSETS, 40, 1, 80);
const JOB_TTL_MINUTES = clampNumber(process.env.JOB_TTL_MINUTES, 180, 15, 720);
const MAX_QUEUE = clampNumber(process.env.MAX_QUEUE, 4, 1, 20);

const app = express();
app.set('trust proxy', 1);

const jobs = new Map();
const queue = [];
let queueRunning = false;
let browserPromise = null;

await fs.mkdir(path.join(JOB_ROOT, 'incoming'), { recursive: true });
await fs.mkdir(path.join(JOB_ROOT, 'jobs'), { recursive: true });

const allowedOrigin = (origin, callback) => {
  if (!origin || origin === FRONTEND_URL) {
    callback(null, true);
    return;
  }
  callback(new Error('Origin không được phép gọi Render Server.'));
};

app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/api/jobs')) {
    const origin = req.get('origin');
    if (origin !== FRONTEND_URL) {
      res.status(403).json({ error: 'Chỉ website MaRa Slide đã cấu hình mới có thể tạo job render.' });
      return;
    }
  }
  next();
});

// Only limit creation requests. Job polling uses GET /api/jobs/:id every few seconds
// and must never consume the creation quota.
const createJobRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bạn đã tạo nhiều job render. Hãy đợi khoảng 15 phút rồi thử lại.' },
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try {
        const folder = path.join(JOB_ROOT, 'incoming');
        await fs.mkdir(folder, { recursive: true });
        callback(null, folder);
      } catch (error) {
        callback(error);
      }
    },
    filename: (_req, file, callback) => {
      callback(null, `${crypto.randomUUID()}-${safeFilename(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: MAX_ASSETS,
  },
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'mara-railway-renderer',
    queue: queue.length,
    active: queueRunning,
    frontendUrl: FRONTEND_URL,
    publicBaseUrlConfigured: Boolean(PUBLIC_BASE_URL),
    rendererVersion: 'release-6',
  });
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('MaRa Railway Renderer is running.');
});

app.post('/api/jobs', createJobRateLimit, upload.array('assets', MAX_ASSETS), async (req, res) => {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  try {
    if (queue.length >= MAX_QUEUE) {
      throw new HttpError(429, 'Máy chủ đang có nhiều video chờ render. Hãy thử lại sau ít phút.');
    }

    const project = parseJsonField(req.body?.project, 'project');
    const options = parseJsonField(req.body?.options, 'options');
    validateProject(project, options);

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64url');
    const jobDir = path.join(JOB_ROOT, 'jobs', id);
    const assetsDir = path.join(jobDir, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });

    const assets = {};
    for (const file of uploadedFiles) {
      const clientName = safeFilename(file.originalname);
      if (assets[clientName]) {
        throw new HttpError(400, `Tên asset trùng nhau: ${clientName}`);
      }
      const finalPath = path.join(assetsDir, clientName);
      await fs.rename(file.path, finalPath);
      assets[clientName] = finalPath;
    }

    ensureProjectAssetsExist(project, assets);

    const now = Date.now();
    const job = {
      id,
      token,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + JOB_TTL_MINUTES * 60 * 1000,
      status: 'queued',
      stage: 'Đã nhận ảnh và video. Đang chờ máy chủ render…',
      progress: 0,
      project,
      options,
      assets,
      jobDir,
      outputPath: path.join(jobDir, 'mara-slide.mp4'),
      error: null,
      cancelled: false,
      activeProcesses: new Set(),
    };

    jobs.set(id, job);
    queue.push(job);
    void runQueue();

    res.status(202).json({
      id,
      token,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
    });
  } catch (error) {
    for (const file of uploadedFiles) {
      await fs.unlink(file.path).catch(() => undefined);
    }
    sendError(res, error);
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/project', async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  try {
    res.json({ project: makeBrowserProject(job) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/jobs/:id/assets/:assetName', async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  const assetName = safeFilename(req.params.assetName);
  const assetPath = job.assets[assetName];
  if (!assetPath) {
    res.status(404).json({ error: 'Không tìm thấy asset.' });
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=7200');
  res.sendFile(assetPath);
});

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  if (job.status !== 'done') {
    res.status(409).json({ error: 'Video chưa render xong.' });
    return;
  }
  try {
    await fs.access(job.outputPath);
    res.download(job.outputPath, `mara-slide-${job.id.slice(0, 8)}.mp4`);
  } catch {
    res.status(404).json({ error: 'File MP4 không còn tồn tại.' });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  job.cancelled = true;
  job.status = 'cancelled';
  job.stage = 'Đã hủy render.';
  job.updatedAt = Date.now();
  for (const process of job.activeProcesses) {
    process.kill('SIGTERM');
  }
  res.json(publicJob(job));
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    sendError(res, new HttpError(400, `Tải tệp không thành công: ${error.message}`));
    return;
  }
  if (error?.message === 'Origin không được phép gọi Render Server.') {
    sendError(res, new HttpError(403, error.message));
    return;
  }
  console.error('Unhandled API error:', error);
  sendError(res, error);
});

setInterval(() => {
  void cleanupExpiredJobs();
}, 15 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`MaRa renderer listening on :${PORT}`);
  console.log(`FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`PUBLIC_BASE_URL=${PUBLIC_BASE_URL || '(missing)'}`);
});

function normalizePublicBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  return /^https?:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized}`;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

function clampNumber(rawValue, fallback, min, max) {
  const number = Number(rawValue);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function safeFilename(value) {
  return path.basename(String(value || 'asset.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseJsonField(value, name) {
  if (typeof value !== 'string') throw new HttpError(400, `Thiếu dữ liệu ${name}.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(400, `Dữ liệu ${name} không hợp lệ.`);
  }
}

function validateProject(project, options) {
  if (!project || !Array.isArray(project.slides) || project.slides.length === 0) {
    throw new HttpError(400, 'Dự án chưa có slide nào.');
  }
  if (!['16:9', '9:16', '1:1'].includes(project.aspectRatio)) {
    throw new HttpError(400, 'Tỷ lệ video không hợp lệ.');
  }
  if (!['720p', '1080p'].includes(options?.resolution)) {
    throw new HttpError(400, 'Độ phân giải render không hợp lệ.');
  }
  if (!['smooth', 'balanced', 'quality'].includes(options?.quality)) {
    throw new HttpError(400, 'Chế độ chất lượng render không hợp lệ.');
  }
  const duration = calculateDuration(project.slides);
  if (duration > MAX_VIDEO_SECONDS) {
    throw new HttpError(400, `Video dài ${duration.toFixed(1)} giây. Máy chủ hiện giới hạn ${MAX_VIDEO_SECONDS} giây mỗi lần render.`);
  }
}

function calculateDuration(slides) {
  return slides.reduce((total, slide, index) => {
    const duration = Math.max(1, Number(slide.duration) || 4);
    const transition = index === slides.length - 1
      ? 0
      : Math.min(Math.max(0.1, Number(slide.transitionDuration) || 1.5), duration);
    return total + duration + transition;
  }, 0);
}

function isAssetReference(value) {
  return typeof value === 'string' && value.startsWith('asset:');
}

function extractAssetName(reference) {
  return safeFilename(reference.slice('asset:'.length));
}

function ensureProjectAssetsExist(project, assets) {
  const references = new Set();
  for (const slide of project.slides) {
    if (isAssetReference(slide.imageSrc)) references.add(extractAssetName(slide.imageSrc));
    for (const image of Array.isArray(slide.images) ? slide.images : []) {
      if (isAssetReference(image.src)) references.add(extractAssetName(image.src));
    }
  }
  for (const track of Array.isArray(project.musicTracks) ? project.musicTracks : []) {
    if (isAssetReference(track.url)) references.add(extractAssetName(track.url));
  }
  for (const assetName of references) {
    if (!assets[assetName]) {
      throw new HttpError(400, `Thiếu file asset ${assetName}.`);
    }
  }
}

function requireJob(req, res) {
  const job = jobs.get(req.params.id);
  const token = String(req.query.token || '');
  const tokenMatches = Boolean(job) && token.length === job.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(job.token));
  if (!job || !tokenMatches) {
    res.status(404).json({ error: 'Không tìm thấy job render.' });
    return null;
  }
  return job;
}

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = req.protocol || 'https';
  return `${protocol}://${req.get('host')}`;
}

function publicJob(job) {
  const base = PUBLIC_BASE_URL || '';
  const query = `token=${encodeURIComponent(job.token)}`;
  return {
    id: job.id,
    token: job.token,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    expiresAt: job.expiresAt,
    downloadUrl: job.status === 'done' && base
      ? `${base}/api/jobs/${job.id}/download?${query}`
      : null,
  };
}

function makeBrowserProject(job) {
  const base = PUBLIC_BASE_URL;
  if (!base) throw new HttpError(500, 'Thiếu biến môi trường PUBLIC_BASE_URL trên Railway.');
  const toBrowserUrl = (value) => {
    if (!isAssetReference(value)) return value;
    const name = extractAssetName(value);
    return `${base}/api/jobs/${job.id}/assets/${encodeURIComponent(name)}?token=${encodeURIComponent(job.token)}`;
  };
  return {
    ...job.project,
    slides: job.project.slides.map((slide) => ({
      ...slide,
      imageSrc: toBrowserUrl(slide.imageSrc),
      images: Array.isArray(slide.images)
        ? slide.images.map((image) => ({ ...image, src: toBrowserUrl(image.src) }))
        : slide.images,
    })),
    musicTracks: Array.isArray(job.project.musicTracks)
      ? job.project.musicTracks.map((track) => ({ ...track, url: toBrowserUrl(track.url) }))
      : [],
  };
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
    });
  }
  return browserPromise;
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job || job.cancelled) continue;
      try {
        await renderJob(job);
      } catch (error) {
        if (job.cancelled) {
          job.status = 'cancelled';
          job.stage = 'Đã hủy render.';
        } else {
          job.status = 'failed';
          job.stage = 'Render server chưa hoàn tất.';
          job.error = error instanceof Error ? error.message : 'Render server gặp lỗi không xác định.';
          console.error(`Render job ${job.id} failed:`, error);
        }
        job.updatedAt = Date.now();
      }
    }
  } finally {
    queueRunning = false;
  }
}

async function renderJob(job) {
  job.status = 'preparing';
  job.stage = 'Đang mở bộ dựng hình trên máy chủ…';
  job.progress = 2;
  job.updatedAt = Date.now();

  if (!PUBLIC_BASE_URL) {
    throw new Error(
      'Thiếu PUBLIC_BASE_URL trên Railway. Hãy đặt giá trị https://mara-railway-renderer-production.up.railway.app rồi deploy lại service.',
    );
  }

  // Verify the temporary project API before Chromium opens the Vercel app.
  // This turns the previous generic “Không thể tải dữ liệu…” into a useful
  // Railway-side error if the URL, job token, or service routing is incorrect.
  const projectUrl = `${PUBLIC_BASE_URL}/api/jobs/${encodeURIComponent(job.id)}/project?token=${encodeURIComponent(job.token)}`;
  const projectProbe = await fetch(projectUrl);
  if (!projectProbe.ok) {
    const body = await projectProbe.text().catch(() => '');
    throw new Error(
      `Railway không đọc được dữ liệu project (HTTP ${projectProbe.status}). ${body.slice(0, 300)}`,
    );
  }

  const output = renderDimensions(job.project.aspectRatio, job.options.resolution);
  const fps = 30;
  const totalDuration = calculateDuration(job.project.slides);
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: output.width, height: output.height },
    deviceScaleFactor: 1,
  });

  try {
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`[renderer browser ${job.id}] ${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      console.error(`[renderer browser ${job.id}] page error:`, error.message);
    });
    page.on('response', (response) => {
      if (response.url().includes('/api/jobs/')) {
        console.log(`[renderer browser ${job.id}] ${response.status()} ${response.url()}`);
      }
    });

    const rendererUrl = `${FRONTEND_URL}/?maraRender=1&job=${encodeURIComponent(job.id)}&token=${encodeURIComponent(job.token)}&api=${encodeURIComponent(PUBLIC_BASE_URL)}`;
    console.log(`[render ${job.id}] Opening renderer URL: ${rendererUrl}`);
    await page.goto(rendererUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(
      () =>
        Boolean(globalThis.__MARA_RENDER_BRIDGE__?.ready) ||
        document.documentElement.dataset.maraRenderer === 'failed',
      null,
      { timeout: 90_000 },
    );
    const rendererFailed = await page.evaluate(
      () => document.documentElement.dataset.maraRenderer === 'failed',
    );
    if (rendererFailed) {
      const message = await page.locator('#mara-renderer-error').textContent().catch(() => null);
      throw new Error(message || 'Trang MaRa Slide không thể tải project render từ Railway.');
    }

    await page.waitForFunction(
      () => document.getElementById('mara-server-render-canvas') instanceof HTMLCanvasElement,
      null,
      { timeout: 30_000 },
    );

    const videoOnlyPath = path.join(job.jobDir, 'video-only.mp4');
    const profile = renderProfile(job.options.quality);

    job.status = 'rendering';
    job.stage = 'Đang render từng khung hình trên Railway…';
    job.progress = 4;
    job.updatedAt = Date.now();

    await streamFramesToFfmpeg({
      job,
      page,
      totalFrames,
      fps,
      totalDuration,
      width: output.width,
      height: output.height,
      videoOnlyPath,
      profile,
    });

    if (job.cancelled) throw new Error('Job đã bị hủy.');

    job.status = 'mixing';
    job.stage = 'Đang ghép nhạc nền và đóng gói MP4…';
    job.progress = 94;
    job.updatedAt = Date.now();

    await addAudioTrack(job, videoOnlyPath, job.outputPath, totalDuration);
    await fs.unlink(videoOnlyPath).catch(() => undefined);

    job.status = 'done';
    job.stage = 'Hoàn tất MP4. Video sẽ được lưu tạm trước khi tự xóa.';
    job.progress = 100;
    job.updatedAt = Date.now();
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function streamFramesToFfmpeg({ job, page, totalFrames, fps, totalDuration, width, height, videoOnlyPath, profile }) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', profile.preset, '-crf', String(profile.crf),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', videoOnlyPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  job.activeProcesses.add(ffmpeg);
  const stderr = [];
  ffmpeg.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const exitPromise = new Promise((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg không thể tạo video: ${stderr.join('').slice(-1500) || `mã lỗi ${code}`}`));
    });
  });

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (job.cancelled) throw new Error('Job đã bị hủy.');
      const timelineTime = Math.min(totalDuration, frameIndex / fps);

      /*
        Never use Locator.screenshot() here. Playwright waits for a DOM element
        to become stable and can throw "Element is not attached to the DOM"
        when React updates the render page. Rendering and reading canvas pixels
        happen in ONE page.evaluate call instead, so every frame comes from the
        current canvas synchronously and CSS/font animations are irrelevant.
      */
      const dataUrl = await page.evaluate(({ timelineTime, width, height }) => {
        const bridge = globalThis.__MARA_RENDER_BRIDGE__;
        if (!bridge?.ready) throw new Error('Canvas renderer chưa sẵn sàng.');

        bridge.renderAt(timelineTime, width, height);
        const canvas = document.getElementById('mara-server-render-canvas');
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('Không tìm thấy canvas server render.');
        }

        try {
          return canvas.toDataURL('image/png');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Không thể đọc khung hình Canvas: ${message}`);
        }
      }, { timelineTime, width, height });

      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex < 0) throw new Error('Canvas không trả về dữ liệu PNG hợp lệ.');
      const png = Buffer.from(dataUrl.slice(commaIndex + 1), 'base64');
      if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain');

      if (frameIndex % 6 === 0 || frameIndex === totalFrames - 1) {
        job.progress = Math.min(93, 4 + Math.round(((frameIndex + 1) / totalFrames) * 89));
        job.stage = `Đang render khung hình ${frameIndex + 1} / ${totalFrames}…`;
        job.updatedAt = Date.now();
      }
    }
    ffmpeg.stdin.end();
    await exitPromise;
  } finally {
    job.activeProcesses.delete(ffmpeg);
    if (!ffmpeg.killed && job.cancelled) ffmpeg.kill('SIGTERM');
  }
}

async function addAudioTrack(job, videoOnlyPath, outputPath, totalDuration) {
  const tracks = Array.isArray(job.project.musicTracks) ? job.project.musicTracks : [];
  if (tracks.length === 0) {
    await fs.rename(videoOnlyPath, outputPath);
    return;
  }

  const audioInputs = [];
  const labels = [];
  const filterParts = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (!isAssetReference(track.url)) continue;
    const assetPath = job.assets[extractAssetName(track.url)];
    if (!assetPath) continue;
    const sourceIndex = labels.length + 1;
    const normalizedOffset = Math.max(0, Number(track.startOffset) || 0);
    const volume = Math.min(1, Math.max(0, Number(track.volume) || 0));
    audioInputs.push('-stream_loop', '-1', '-ss', String(normalizedOffset), '-i', assetPath);
    const label = `a${labels.length}`;
    labels.push(`[${sourceIndex}:a]`);
    filterParts.push(`[${sourceIndex}:a]volume=${volume.toFixed(3)}[${label}]`);
  }

  if (labels.length === 0) {
    await fs.rename(videoOnlyPath, outputPath);
    return;
  }

  const mixedLabel = 'mixed';
  filterParts.push(`${labels.map((_unused, index) => `[a${index}]`).join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${mixedLabel}]`);

  await runFfmpeg(job, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoOnlyPath,
    ...audioInputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v:0', '-map', `[${mixedLabel}]`,
    '-t', totalDuration.toFixed(3),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', outputPath,
  ], 'Không thể ghép nhạc nền');
}

function renderDimensions(aspectRatio, resolution) {
  const landscape = resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  if (aspectRatio === '9:16') return { width: landscape.height, height: landscape.width };
  if (aspectRatio === '1:1') return { width: landscape.height, height: landscape.height };
  return landscape;
}

function renderProfile(quality) {
  if (quality === 'quality') return { preset: 'slow', crf: 17 };
  if (quality === 'balanced') return { preset: 'medium', crf: 18 };
  return { preset: 'veryfast', crf: 20 };
}

async function runFfmpeg(job, args, prefix) {
  const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  job.activeProcesses.add(process);
  const stderr = [];
  process.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  try {
    await new Promise((resolve, reject) => {
      process.once('error', reject);
      process.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${prefix}: ${stderr.join('').slice(-1500) || `mã lỗi ${code}`}`));
      });
    });
  } finally {
    job.activeProcesses.delete(process);
  }
}

async function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.expiresAt > now || ['queued', 'preparing', 'rendering', 'mixing'].includes(job.status)) continue;
    jobs.delete(id);
    await fs.rm(job.jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Máy chủ render gặp lỗi không xác định.';
  res.status(status).json({ error: message });
}
