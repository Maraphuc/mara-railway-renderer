import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { renderProjectToVideo } from './render/engine.js';
import { calculateProjectDuration } from './render/timeline.js';
import { safeFilename, safeNumber, trimTrailingSlash } from './render/utils.js';

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = trimTrailingSlash(process.env.FRONTEND_URL || 'https://slidemara.vercel.app');
const PUBLIC_BASE_URL = normalisePublicUrl(process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
const JOB_ROOT = process.env.JOB_ROOT || '/tmp/mara-pro-render-jobs';
const MAX_UPLOAD_MB = clampNumber(process.env.MAX_UPLOAD_MB, 300, 20, 900);
const MAX_VIDEO_SECONDS = clampNumber(process.env.MAX_VIDEO_SECONDS, 180, 10, 900);
const MAX_ASSETS = clampNumber(process.env.MAX_ASSETS, 60, 1, 120);
const JOB_TTL_MINUTES = clampNumber(process.env.JOB_TTL_MINUTES, 180, 15, 720);
const MAX_QUEUE = clampNumber(process.env.MAX_QUEUE, 3, 1, 20);
const RENDERER_VERSION = process.env.RENDERER_VERSION || 'capcut-pro-2';

const app = express();
app.set('trust proxy', 1);
const jobs = new Map();
const queue = [];
let activeJob = null;

await fs.mkdir(path.join(JOB_ROOT, 'incoming'), { recursive: true });
await fs.mkdir(path.join(JOB_ROOT, 'jobs'), { recursive: true });

/**
 * CORS is handled explicitly before every route so success responses, validation errors,
 * rate-limit responses, and polling responses all carry the same headers.
 * The API is still limited to the configured MaRa Slide origins; it is not opened to every site.
 */
const allowedOrigins = new Set([
  FRONTEND_URL,
  ...String(process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map(trimTrailingSlash)
    .filter(Boolean),
]);

function requestOriginIsAllowed(origin) {
  if (!origin) return true; // Railway health checks / direct browser visits do not send Origin.
  return allowedOrigins.has(trimTrailingSlash(origin));
}

app.use((req, res, next) => {
  const origin = req.get('origin');
  const isAllowed = requestOriginIsAllowed(origin);

  // Set CORS headers before any route, multer, rate limiter, or error handler responds.
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.get('access-control-request-headers') || 'Content-Type, Authorization',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    if (!isAllowed) {
      return res.status(403).json({ error: 'Origin không được phép gọi Render Server.' });
    }
    return res.status(204).end();
  }

  if (origin && !isAllowed) {
    return res.status(403).json({ error: 'Origin không được phép gọi Render Server.' });
  }

  return next();
});

app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try { const folder = path.join(JOB_ROOT, 'incoming'); await fs.mkdir(folder, { recursive: true }); callback(null, folder); }
      catch (error) { callback(error); }
    },
    filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}-${safeFilename(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_ASSETS },
});

app.use('/api/jobs', rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
  message: { error: 'Bạn đã tạo nhiều job render trong thời gian ngắn. Hãy đợi vài phút rồi thử lại.' },
}));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'mara-capcut-pro-renderer',
    rendererVersion: RENDERER_VERSION,
    queue: queue.length,
    active: Boolean(activeJob),
    frontendUrl: FRONTEND_URL,
    allowedOrigins: [...allowedOrigins],
    publicBaseUrlConfigured: Boolean(PUBLIC_BASE_URL),
    engine: 'deterministic-node-canvas-ffmpeg',
  });
});
app.get('/', (_req, res) => res.type('text/plain').send('MaRa CapCut Pro Render Engine is running.'));

app.post('/api/jobs', upload.array('assets', MAX_ASSETS), async (req, res) => {
  const uploaded = Array.isArray(req.files) ? req.files : [];
  try {
    if (!PUBLIC_BASE_URL) throw new HttpError(500, 'Thiếu PUBLIC_BASE_URL trên Railway. Hãy đặt thành domain Railway public có https://.');
    if (queue.length + (activeJob ? 1 : 0) >= MAX_QUEUE) throw new HttpError(429, 'Máy chủ đang có nhiều video chờ render. Hãy thử lại sau ít phút.');
    const project = parseJsonField(req.body?.project, 'project');
    const options = parseJsonField(req.body?.options, 'options');
    validateProject(project, options);
    const id = crypto.randomUUID(); const token = crypto.randomBytes(24).toString('base64url');
    const jobDir = path.join(JOB_ROOT, 'jobs', id); const assetsDir = path.join(jobDir, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    const assets = {};
    for (const file of uploaded) {
      const name = safeFilename(file.originalname);
      if (assets[name]) throw new HttpError(400, `Tên asset trùng nhau: ${name}`);
      const finalPath = path.join(assetsDir, name); await fs.rename(file.path, finalPath); assets[name] = finalPath;
    }
    ensureProjectAssets(project, assets);
    const now = Date.now();
    const job = { id, token, createdAt: now, updatedAt: now, expiresAt: now + JOB_TTL_MINUTES * 60 * 1000, status: 'queued', stage: 'Đã nhận dự án. Đang xếp hàng Render Engine Pro…', progress: 0, project, options, assets, jobDir, outputPath: path.join(jobDir, 'mara-slide.mp4'), error: null, cancelled: false, activeProcesses: new Set(), abortController: new AbortController(), seed: crypto.randomBytes(4).readUInt32LE(0) };
    jobs.set(id, job); queue.push(job); void runQueue();
    res.status(202).json(publicJob(job));
  } catch (error) {
    await Promise.all(uploaded.map((file) => fs.unlink(file.path).catch(() => undefined)));
    sendError(res, error);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = requireJob(req, res); if (!job) return; res.json(publicJob(job));
});

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = requireJob(req, res); if (!job) return;
  if (job.status !== 'done') return res.status(409).json({ error: 'Video chưa render xong.' });
  try { await fs.access(job.outputPath); return res.download(job.outputPath, `mara-slide-${job.id.slice(0, 8)}.mp4`); }
  catch { return res.status(404).json({ error: 'File MP4 không còn tồn tại.' }); }
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = requireJob(req, res); if (!job) return;
  job.cancelled = true; job.abortController.abort(); job.status = 'cancelled'; job.stage = 'Đã hủy render.'; job.updatedAt = Date.now();
  for (const process of job.activeProcesses) process.kill('SIGTERM');
  res.json(publicJob(job));
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return sendError(res, new HttpError(400, `Tải tệp không thành công: ${error.message}`));
  if (error?.message === 'Origin không được phép gọi Render Server.') return sendError(res, new HttpError(403, error.message));
  console.error('Unhandled API error:', error); return sendError(res, error);
});

setInterval(() => { void cleanupExpiredJobs(); }, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`MaRa CapCut Pro renderer listening on :${PORT}`);
  console.log(`FRONTEND_URL=${FRONTEND_URL}`);
  console.log(`ALLOWED_ORIGINS=${[...allowedOrigins].join(',')}`);
  console.log(`PUBLIC_BASE_URL=${PUBLIC_BASE_URL || '(missing)'}`);
});

async function runQueue() {
  if (activeJob) return;
  while (queue.length) {
    const job = queue.shift(); if (!job || job.cancelled) continue;
    activeJob = job;
    try {
      job.status = 'preparing'; job.stage = 'Đang chuẩn bị Render Engine Pro…'; job.progress = 1; job.updatedAt = Date.now();
      await renderProjectToVideo({
        job,
        signal: job.abortController.signal,
        onStage(stage) { job.stage = stage; job.updatedAt = Date.now(); },
        onProgress(progress) { job.progress = progress; job.updatedAt = Date.now(); },
      });
      if (!job.cancelled) { job.status = 'done'; job.stage = 'Hoàn tất MP4. Bạn có thể tải video xuống.'; job.progress = 100; job.updatedAt = Date.now(); }
    } catch (error) {
      if (job.cancelled || job.abortController.signal.aborted) { job.status = 'cancelled'; job.stage = 'Đã hủy render.'; }
      else { job.status = 'failed'; job.stage = 'Render Engine Pro chưa hoàn tất.'; job.error = error instanceof Error ? error.message : 'Máy chủ render gặp lỗi không xác định.'; console.error(`[render ${job.id}]`, error); }
      job.updatedAt = Date.now();
    } finally { activeJob = null; }
  }
}

function validateProject(project, options) {
  if (!project || !Array.isArray(project.slides) || !project.slides.length) throw new HttpError(400, 'Dự án chưa có slide nào.');
  if (!['16:9', '9:16', '1:1'].includes(project.aspectRatio)) throw new HttpError(400, 'Tỷ lệ video không hợp lệ.');
  if (!['720p', '1080p'].includes(options?.resolution)) throw new HttpError(400, 'Độ phân giải render không hợp lệ.');
  if (!['smooth', 'balanced', 'quality'].includes(options?.quality)) throw new HttpError(400, 'Chế độ chất lượng render không hợp lệ.');
  const duration = calculateProjectDuration(project.slides);
  if (duration > MAX_VIDEO_SECONDS) throw new HttpError(400, `Video dài ${duration.toFixed(1)} giây. Máy chủ hiện giới hạn ${MAX_VIDEO_SECONDS} giây mỗi lần render.`);
}

function ensureProjectAssets(project, assets) {
  const refs = new Set();
  for (const slide of project.slides || []) {
    if (isAssetRef(slide?.imageSrc)) refs.add(assetName(slide.imageSrc));
    for (const image of Array.isArray(slide?.images) ? slide.images : []) if (isAssetRef(image?.src)) refs.add(assetName(image.src));
  }
  for (const track of project.musicTracks || []) if (isAssetRef(track?.url)) refs.add(assetName(track.url));
  for (const ref of refs) if (!assets[ref]) throw new HttpError(400, `Thiếu file asset ${ref}.`);
}

function isAssetRef(value) { return typeof value === 'string' && value.startsWith('asset:'); }
function assetName(value) { return safeFilename(value.slice('asset:'.length)); }
function parseJsonField(value, name) { if (typeof value !== 'string') throw new HttpError(400, `Thiếu dữ liệu ${name}.`); try { return JSON.parse(value); } catch { throw new HttpError(400, `Dữ liệu ${name} không hợp lệ.`); } }
function requireJob(req, res) {
  const job = jobs.get(req.params.id); const token = String(req.query.token || '');
  if (!job || !token || token.length !== job.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(job.token))) { res.status(404).json({ error: 'Không tìm thấy job render.' }); return null; }
  return job;
}
function publicJob(job) { const query = `token=${encodeURIComponent(job.token)}`; return { id: job.id, token: job.token, status: job.status, stage: job.stage, progress: job.progress, error: job.error, expiresAt: job.expiresAt, downloadUrl: job.status === 'done' ? `${PUBLIC_BASE_URL}/api/jobs/${job.id}/download?${query}` : null }; }
async function cleanupExpiredJobs() { const now = Date.now(); for (const [id, job] of jobs.entries()) { if (job.expiresAt > now || ['queued', 'preparing', 'rendering', 'mixing'].includes(job.status)) continue; jobs.delete(id); await fs.rm(job.jobDir, { recursive: true, force: true }).catch(() => undefined); } }
function clampNumber(raw, fallback, min, max) { return safeNumber(raw, fallback, min, max); }
function normalisePublicUrl(raw) { const value = trimTrailingSlash(raw); if (!value) return ''; return /^https?:\/\//i.test(value) ? value : `https://${value}`; }
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function sendError(res, error) { const status = error instanceof HttpError ? error.status : 500; const message = error instanceof Error ? error.message : 'Máy chủ render gặp lỗi không xác định.'; res.status(status).json({ error: message }); }
