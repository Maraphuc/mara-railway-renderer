import { createCanvas, loadImage } from '@napi-rs/canvas';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildTimeline, calculateProjectDuration, getFrameState, slideProgress } from './timeline.js';
import { clamp, safeFilename } from './utils.js';
import { composeTransition, drawParticles, drawSlide, getSlideImages, resolvedTransitionForSlide } from './draw.js';

export function renderDimensions(aspectRatio, resolution) {
  const landscape = resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  if (aspectRatio === '9:16') return { width: landscape.height, height: landscape.width };
  if (aspectRatio === '1:1') return { width: landscape.height, height: landscape.height };
  return landscape;
}

export function renderProfile(quality) {
  if (quality === 'quality') return { preset: 'slow', crf: 17 };
  if (quality === 'balanced') return { preset: 'medium', crf: 18 };
  return { preset: 'veryfast', crf: 20 };
}

function resolveAssetPath(reference, assets) {
  if (typeof reference !== 'string') return null;
  if (reference.startsWith('asset:')) return assets[safeFilename(reference.slice('asset:'.length))] || null;
  return assets[safeFilename(reference)] || null;
}

async function preloadProjectImages(project, assets) {
  const sources = new Set();
  for (const slide of project.slides || []) {
    for (const image of getSlideImages(slide)) if (image?.src) sources.add(image.src);
  }
  const cache = new Map();
  await Promise.all([...sources].map(async (source) => {
    const filePath = resolveAssetPath(source, assets);
    if (!filePath) throw new Error(`Không tìm thấy file hình ảnh: ${source}`);
    const data = await fs.readFile(filePath);
    cache.set(source, await loadImage(data));
  }));
  return cache;
}

function rawCanvasBuffer(canvas) {
  const raw = canvas.data();
  if (!Buffer.isBuffer(raw) || raw.length !== canvas.width * canvas.height * 4) {
    throw new Error('Canvas renderer không tạo được raw frame RGBA hợp lệ.');
  }
  return raw;
}

async function writeWithBackpressure(stream, buffer, signal) {
  if (signal?.aborted) throw new Error('Job đã bị hủy.');
  if (!stream.write(buffer)) await once(stream, 'drain');
}

async function runFfmpeg(job, args, errorPrefix) {
  const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  job.activeProcesses.add(process);
  const stderr = [];
  process.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  try {
    await new Promise((resolve, reject) => {
      process.once('error', reject);
      process.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${errorPrefix}: ${stderr.join('').slice(-1800) || `mã lỗi ${code}`}`)));
    });
  } finally {
    job.activeProcesses.delete(process);
  }
}

async function addAudioTracks(job, videoOnlyPath, outputPath, duration) {
  const tracks = Array.isArray(job.project.musicTracks) ? job.project.musicTracks : [];
  const usable = tracks.map((track) => ({ track, path: resolveAssetPath(track.url, job.assets) })).filter((entry) => entry.path);
  if (!usable.length) { await fs.rename(videoOnlyPath, outputPath); return; }
  const audioInputs = []; const labels = []; const filters = [];
  usable.forEach(({ track, path: sourcePath }, index) => {
    const offset = Math.max(0, Number(track.startOffset) || 0);
    const volume = clamp(Number(track.volume) || 0, 0, 1);
    audioInputs.push('-stream_loop', '-1', '-ss', String(offset), '-i', sourcePath);
    filters.push(`[${index + 1}:a]volume=${volume.toFixed(3)}[a${index}]`);
    labels.push(`[a${index}]`);
  });
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[mix]`);
  await runFfmpeg(job, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoOnlyPath,
    ...audioInputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0', '-map', '[mix]', '-t', duration.toFixed(3),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
  ], 'Không thể ghép nhạc nền');
}

export async function renderProjectToVideo({ job, signal, onStage, onProgress }) {
  const project = job.project;
  const options = job.options;
  const fps = 30;
  const duration = calculateProjectDuration(project.slides);
  const timeline = buildTimeline(project.slides);
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const { width, height } = renderDimensions(project.aspectRatio, options.resolution);
  const profile = renderProfile(options.quality);

  onStage('Đang tải và tối ưu ảnh cho Render Engine Pro…'); onProgress(2);
  const images = await preloadProjectImages(project, job.assets);
  if (signal?.aborted) throw new Error('Job đã bị hủy.');

  const stage = createCanvas(width, height); const stageCtx = stage.getContext('2d');
  const outgoing = createCanvas(width, height); const outgoingCtx = outgoing.getContext('2d');
  const incoming = createCanvas(width, height); const incomingCtx = incoming.getContext('2d');
  const videoOnlyPath = path.join(job.jobDir, 'video-only.mp4');
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    // @napi-rs/canvas canvas.data() returns bytes in RGBA order.
    // Feeding FFmpeg as BGRA swaps red and blue, producing incorrect colours.
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', profile.preset, '-crf', String(profile.crf),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', videoOnlyPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  job.activeProcesses.add(ffmpeg);
  const stderr = [];
  ffmpeg.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  const ffmpegExit = new Promise((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg không thể tạo video: ${stderr.join('').slice(-1800) || `mã lỗi ${code}`}`)));
  });

  let previousTransition = null;
  const resolvedTransitions = new Map();
  for (const item of timeline) { const resolved = resolvedTransitionForSlide(item.slide, previousTransition); resolvedTransitions.set(item.index, resolved); previousTransition = resolved; }

  try {
    onStage('Đang render từng frame bằng Engine Pro (không dùng Chromium)…'); onProgress(4);
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (signal?.aborted) throw new Error('Job đã bị hủy.');
      const time = Math.min(Math.max(0, duration - 1 / fps), frameIndex / fps);
      const state = getFrameState(timeline, time);
      stageCtx.clearRect(0, 0, width, height);
      if (state.transition) {
        const { outgoing: outgoingItem, incoming: incomingItem, progress } = state.transition;
        drawSlide(outgoingCtx, outgoingItem.slide, slideProgress(outgoingItem, time), width, height, images);
        drawSlide(incomingCtx, incomingItem.slide, slideProgress(incomingItem, time), width, height, images);
        composeTransition(stageCtx, outgoing, incoming, resolvedTransitions.get(outgoingItem.index) || 'fade', progress);
      } else if (state.current) {
        drawSlide(stageCtx, state.current.slide, slideProgress(state.current, time), width, height, images);
      }
      drawParticles(stageCtx, project.globalParticleEffect, time, width, height, Number(job.seed || 1));
      await writeWithBackpressure(ffmpeg.stdin, rawCanvasBuffer(stage), signal);
      if (frameIndex % Math.max(3, Math.floor(fps / 4)) === 0 || frameIndex === totalFrames - 1) {
        const percent = Math.min(92, 4 + Math.round(((frameIndex + 1) / totalFrames) * 88));
        onProgress(percent); onStage(`Đang render frame ${frameIndex + 1} / ${totalFrames}…`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    ffmpeg.stdin.end(); await ffmpegExit;
  } finally {
    job.activeProcesses.delete(ffmpeg);
    if (signal?.aborted && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
  }

  if (signal?.aborted) throw new Error('Job đã bị hủy.');
  onStage('Đang ghép nhạc nền và đóng gói MP4…'); onProgress(94);
  await addAudioTracks(job, videoOnlyPath, job.outputPath, duration);
  await fs.unlink(videoOnlyPath).catch(() => undefined);
  onStage('Hoàn tất MP4. Video sẽ tự xóa sau thời hạn lưu tạm.'); onProgress(100);
  return { duration, totalFrames, width, height, fps };
}
