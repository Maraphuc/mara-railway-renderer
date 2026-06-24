import {
  clamp,
  easeInCubic,
  easeInOut,
  easeOutCubic,
  hashString,
  hexToRgba,
  lerp,
  roundedRectPath,
  seededUnit,
  splitLines,
} from './utils.js';
import { resolveMotion, resolveTransition } from './timeline.js';

const DEFAULT_BACKGROUND = '#09090b';

export function getSlideImages(slide) {
  if (Array.isArray(slide?.images) && slide.images.length) return slide.images.slice(0, 4);
  return [{ id: `${slide?.id || 'slide'}-primary`, src: slide?.imageSrc, name: slide?.imageName || 'Ảnh slide' }];
}

export function getLayoutCells(layout, width, height, gapValue) {
  const gap = Math.max(0, Math.min(36, Number(gapValue) || 10));
  const halfWidth = (width - gap) / 2;
  const halfHeight = (height - gap) / 2;
  switch (layout || 'single') {
    case 'split-vertical': return [{ x: 0, y: 0, width: halfWidth, height }, { x: halfWidth + gap, y: 0, width: halfWidth, height }];
    case 'split-horizontal': return [{ x: 0, y: 0, width, height: halfHeight }, { x: 0, y: halfHeight + gap, width, height: halfHeight }];
    case 'grid-4': return [
      { x: 0, y: 0, width: halfWidth, height: halfHeight },
      { x: halfWidth + gap, y: 0, width: halfWidth, height: halfHeight },
      { x: 0, y: halfHeight + gap, width: halfWidth, height: halfHeight },
      { x: halfWidth + gap, y: halfHeight + gap, width: halfWidth, height: halfHeight },
    ];
    case 'hero-left': {
      const hero = width * 0.61 - gap / 2; const side = width - hero - gap;
      return [{ x: 0, y: 0, width: hero, height }, { x: hero + gap, y: 0, width: side, height: halfHeight }, { x: hero + gap, y: halfHeight + gap, width: side, height: halfHeight }];
    }
    case 'hero-right': {
      const hero = width * 0.61 - gap / 2; const side = width - hero - gap;
      return [{ x: 0, y: 0, width: side, height: halfHeight }, { x: 0, y: halfHeight + gap, width: side, height: halfHeight }, { x: side + gap, y: 0, width: hero, height }];
    }
    case 'strip-3': {
      const item = (width - gap * 2) / 3;
      return [{ x: 0, y: 0, width: item, height }, { x: item + gap, y: 0, width: item, height }, { x: (item + gap) * 2, y: 0, width: item, height }];
    }
    case 'album-stack': return [
      { x: width * 0.08, y: height * 0.2, width: width * 0.54, height: height * 0.62 },
      { x: width * 0.38, y: height * 0.12, width: width * 0.54, height: height * 0.66 },
      { x: width * 0.2, y: height * 0.31, width: width * 0.5, height: height * 0.56 },
      { x: width * 0.49, y: height * 0.31, width: width * 0.39, height: height * 0.48 },
    ];
    case 'editorial-4': {
      const hero = width * 0.62 - gap / 2; const side = width - hero - gap; const top = height * 0.5 - gap / 2; const bottom = height - top - gap; const lower = (side - gap) / 2;
      return [{ x: 0, y: 0, width: hero, height }, { x: hero + gap, y: 0, width: side, height: top }, { x: hero + gap, y: top + gap, width: lower, height: bottom }, { x: hero + gap + lower + gap, y: top + gap, width: lower, height: bottom }];
    }
    case 'storyboard-4': {
      const top = height * 0.62 - gap / 2; const bottom = height - top - gap; const item = (width - gap * 2) / 3;
      return [{ x: 0, y: 0, width, height: top }, { x: 0, y: top + gap, width: item, height: bottom }, { x: item + gap, y: top + gap, width: item, height: bottom }, { x: (item + gap) * 2, y: top + gap, width: item, height: bottom }];
    }
    case 'magazine-3': {
      const top = height * 0.6 - gap / 2; const bottom = height - top - gap; const item = (width - gap) / 2;
      return [{ x: 0, y: 0, width, height: top }, { x: 0, y: top + gap, width: item, height: bottom }, { x: item + gap, y: top + gap, width: item, height: bottom }];
    }
    case 'mosaic-4': {
      const left = width * 0.57 - gap / 2; const right = width - left - gap; const top = height * 0.58 - gap / 2; const bottom = height - top - gap;
      return [{ x: 0, y: 0, width: left, height: top }, { x: left + gap, y: 0, width: right, height: top }, { x: 0, y: top + gap, width: right, height: bottom }, { x: right + gap, y: top + gap, width: left, height: bottom }];
    }
    case 'filmstrip-4': {
      const item = (width - gap * 3) / 4;
      return Array.from({ length: 4 }, (_, index) => ({ x: index * (item + gap), y: 0, width: item, height }));
    }
    case 'postcard-wall': {
      const outer = Math.max(10, gap + 8); const cardGap = Math.max(8, gap); const cardW = (width - outer * 2 - cardGap) / 2; const cardH = (height - outer * 2 - cardGap) / 2;
      return [{ x: outer, y: outer, width: cardW, height: cardH }, { x: outer + cardW + cardGap, y: outer, width: cardW, height: cardH }, { x: outer, y: outer + cardH + cardGap, width: cardW, height: cardH }, { x: outer + cardW + cardGap, y: outer + cardH + cardGap, width: cardW, height: cardH }];
    }
    default: return [{ x: 0, y: 0, width, height }];
  }
}

function applyFilter(context, filter, extra = 0) {
  const values = {
    none: '',
    vintage: 'sepia(0.55) contrast(1.10) saturate(0.90) brightness(0.95)',
    grayscale: 'grayscale(1) contrast(1.10)',
    warm: 'sepia(0.18) saturate(1.28) hue-rotate(-8deg)',
    cool: 'saturate(1.1) hue-rotate(12deg) brightness(1.02)',
    vivid: 'saturate(1.65) contrast(1.15)',
    'dramatic-dark': 'contrast(1.35) brightness(0.70) saturate(0.82)',
  };
  try {
    context.filter = [values[filter] || '', extra > 0 ? `blur(${extra}px)` : ''].filter(Boolean).join(' ') || 'none';
  } catch {
    // Some native Canvas builds may not expose CSS filters. Rendering still continues without them.
  }
}

function resetFilter(context) {
  try { context.filter = 'none'; } catch {}
}

function motionForCell(slide, index, progress, rect) {
  const motion = resolveMotion(slide, index);
  const center = progress - 0.5;
  const contain = (slide?.imageFit || 'contain') === 'contain';
  let scale = 1; let x = 0; let y = 0;
  const motionScale = contain ? 0.22 : 1;
  switch (motion) {
    case 'zoom-in': scale = contain ? lerp(0.91, 0.99, progress) : lerp(1.02, 1.18, progress); break;
    case 'zoom-out': scale = contain ? lerp(0.99, 0.91, progress) : lerp(1.18, 1.02, progress); break;
    case 'pan-left': scale = contain ? 0.95 : 1.18; x = -center * rect.width * 0.13 * motionScale; break;
    case 'pan-right': scale = contain ? 0.95 : 1.18; x = center * rect.width * 0.13 * motionScale; break;
    case 'pan-up': scale = contain ? 0.95 : 1.18; y = -center * rect.height * 0.13 * motionScale; break;
    case 'pan-down': scale = contain ? 0.95 : 1.18; y = center * rect.height * 0.13 * motionScale; break;
    case 'diagonal-left': scale = contain ? 0.93 : 1.2; x = -center * rect.width * 0.12 * motionScale; y = -center * rect.height * 0.09 * motionScale; break;
    case 'diagonal-right': scale = contain ? 0.93 : 1.2; x = center * rect.width * 0.12 * motionScale; y = -center * rect.height * 0.09 * motionScale; break;
    case 'zoom-pan': scale = contain ? lerp(0.92, 0.98, progress) : lerp(1.08, 1.21, progress); x = (index % 2 ? -1 : 1) * center * rect.width * 0.05 * motionScale; y = -center * rect.height * 0.06 * motionScale; break;
    case 'sway': scale = contain ? 0.95 : 1.18; x = Math.sin(progress * Math.PI) * (index % 2 ? -1 : 1) * rect.width * 0.04 * motionScale; y = Math.cos(progress * Math.PI * 0.85) * rect.height * 0.018 * motionScale; break;
    default: break;
  }
  return { scale, x, y };
}

function appearanceForCell(slide, index, count, progress, rect) {
  if (count < 2) return { opacity: 1, scale: 1, x: 0, y: 0, rotation: 0, reveal: 1, card: false, origin: 'left' };
  const style = slide?.multiImageAnimation || 'album';
  const duration = Math.min(Math.max(0.5, Number(slide?.multiImageAnimationDuration) || 1.8), Math.max(0.5, Number(slide?.duration) || 4));
  const time = clamp(progress) * Math.max(1, Number(slide?.duration) || 4);
  const stagger = Math.min(duration * 0.56, 0.92);
  const start = count <= 1 ? 0 : (index / Math.max(1, count - 1)) * stagger;
  const raw = clamp((time - start) / Math.max(0.28, duration - start));
  const e = easeOutCubic(raw);
  const seed = Number(slide?.multiImageAnimationSeed) || hashString(`${slide?.id || 'slide'}:multi`);
  const direction = hashString(`${seed}-${index}`) % 2 === 0 ? 1 : -1;
  const tilt = (((hashString(`${seed}-tilt-${index}`) % 9) - 4) * Math.PI / 180) * 0.42;
  const cardLayout = slide?.layout === 'album-stack' || slide?.layout === 'postcard-wall';
  switch (style) {
    case 'album': return { opacity: e, scale: lerp(0.84, 1, e), x: direction * rect.width * 0.08 * (1 - e), y: rect.height * 0.14 * (1 - e), rotation: tilt * (1.05 - e * 0.42), reveal: 1, card: true, origin: 'left' };
    case 'stagger-fade': return { opacity: e, scale: lerp(0.98, 1, e), x: 0, y: rect.height * 0.09 * (1 - e), rotation: 0, reveal: 1, card: false, origin: 'left' };
    case 'stagger-slide': return { opacity: lerp(0.2, 1, e), scale: 1, x: direction * rect.width * 0.26 * (1 - e), y: 0, rotation: direction * 0.025 * (1 - e), reveal: 1, card: false, origin: 'left' };
    case 'stagger-pop': return { opacity: e, scale: lerp(0.72, 1, e), x: 0, y: rect.height * 0.035 * (1 - e), rotation: 0, reveal: 1, card: false, origin: 'left' };
    case 'shutter-reveal': return { opacity: 1, scale: lerp(1.08, 1, e), x: 0, y: 0, rotation: 0, reveal: e, card: false, origin: 'center' };
    case 'cinematic-drift': return { opacity: lerp(0.32, 1, e), scale: lerp(0.93, 1, e), x: direction * rect.width * (0.045 * (1 - e) + 0.008 * Math.sin(progress * Math.PI)), y: -rect.height * 0.012 * Math.sin(progress * Math.PI), rotation: 0, reveal: 1, card: false, origin: 'left' };
    case 'cascade-rise': return { opacity: e, scale: lerp(0.9, 1, e), x: direction * rect.width * 0.025 * (1 - e), y: rect.height * 0.34 * (1 - e), rotation: direction * 0.035 * (1 - e), reveal: 1, card: false, origin: 'left' };
    case 'center-unfold': return { opacity: lerp(0.35, 1, e), scale: lerp(0.98, 1, e), x: 0, y: 0, rotation: 0, reveal: e, card: false, origin: 'center', scaleX: lerp(0.12, 1, e) };
    case 'mosaic-wave': return { opacity: e, scale: lerp(0.86, 1, e), x: direction * rect.width * 0.055 * (1 - e), y: rect.height * (0.16 + Math.sin((index + 1) * 0.82 + e * Math.PI) * 0.035) * (1 - e), rotation: direction * 0.018 * (1 - e), reveal: 1, card: false, origin: 'left' };
    case 'polaroid-drop': return { opacity: e, scale: lerp(0.82, 1, e), x: direction * rect.width * 0.1 * (1 - e), y: -rect.height * 0.35 * (1 - e), rotation: tilt * (1.25 - e * 0.35), reveal: 1, card: true, origin: 'left' };
    case 'scatter-assemble': return { opacity: e, scale: lerp(0.72, 1, e), x: direction * rect.width * 0.32 * (1 - e), y: (hashString(`${seed}-v-${index}`) % 2 ? 1 : -1) * rect.height * 0.24 * (1 - e), rotation: direction * 0.14 * (1 - e), reveal: 1, card: cardLayout, origin: 'left' };
    default: return { opacity: 1, scale: 1, x: 0, y: 0, rotation: 0, reveal: 1, card: cardLayout, origin: 'left' };
  }
}

function stackForCell(slide, index) {
  if (slide?.layout !== 'album-stack' && slide?.layout !== 'postcard-wall') return { rotation: 0, x: 0, y: 0, card: false };
  const seed = Number(slide?.multiImageAnimationSeed) || hashString(`${slide?.id || 'slide'}:stack`);
  const direction = hashString(`${seed}-stack-${index}`) % 2 ? 1 : -1;
  const base = slide.layout === 'postcard-wall' ? [-0.026, 0.022, 0.018, -0.02] : [-0.09, 0.075, -0.045, 0.1];
  return { rotation: base[index % base.length] + direction * 0.008, x: direction * (slide.layout === 'postcard-wall' ? 1.5 : index % 2 ? 5 : -5), y: slide.layout === 'postcard-wall' ? 0 : index === 2 ? 9 : 0, card: true };
}

function drawImageInCell(context, image, slide, progress, rect, index, count) {
  if (!image) return;
  const appearance = appearanceForCell(slide, index, count, progress, rect);
  const stack = stackForCell(slide, index);
  const card = appearance.card || stack.card;
  const padding = card ? Math.max(5, Math.min(13, Math.min(rect.width, rect.height) * 0.045)) : 0;
  const media = { x: rect.x + padding, y: rect.y + padding, width: Math.max(1, rect.width - padding * 2), height: Math.max(1, rect.height - padding * 2) };
  const motion = motionForCell(slide, index, progress, media);
  const fit = slide?.imageFit || 'contain';
  const sourceRatio = image.width / image.height;
  const targetRatio = media.width / media.height;
  let drawW; let drawH;
  if (fit === 'cover') {
    if (sourceRatio > targetRatio) { drawH = media.height * motion.scale; drawW = drawH * sourceRatio; }
    else { drawW = media.width * motion.scale; drawH = drawW / sourceRatio; }
  } else if (sourceRatio > targetRatio) { drawW = media.width * motion.scale; drawH = drawW / sourceRatio; }
  else { drawH = media.height * motion.scale; drawW = drawH * sourceRatio; }
  const maxX = fit === 'contain' ? Math.max(0, (media.width - drawW) / 2) : Infinity;
  const maxY = fit === 'contain' ? Math.max(0, (media.height - drawH) / 2) : Infinity;
  const x = media.x + (media.width - drawW) / 2 + clamp(motion.x, -maxX, maxX);
  const y = media.y + (media.height - drawH) / 2 + clamp(motion.y, -maxY, maxY);

  context.save();
  context.globalAlpha = clamp(appearance.opacity);
  context.translate(rect.x + rect.width / 2 + appearance.x + stack.x, rect.y + rect.height / 2 + appearance.y + stack.y);
  context.rotate(appearance.rotation + stack.rotation);
  context.scale(appearance.scale * (appearance.scaleX || 1), appearance.scale);
  context.translate(-(rect.x + rect.width / 2), -(rect.y + rect.height / 2));

  if (card) {
    context.save();
    context.shadowColor = 'rgba(0,0,0,0.34)'; context.shadowBlur = Math.max(8, Math.min(22, rect.width * 0.05)); context.shadowOffsetY = Math.max(3, Math.min(10, rect.height * 0.03));
    context.fillStyle = 'rgba(250,250,250,0.98)'; roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, Math.max(8, padding * 1.6)); context.fill(); context.restore();
  }

  context.save();
  roundedRectPath(context, media.x, media.y, media.width, media.height, card ? Math.max(5, padding) : 8); context.clip();
  context.fillStyle = slide?.layoutBackground || DEFAULT_BACKGROUND; context.fillRect(media.x, media.y, media.width, media.height);

  if (fit === 'contain') {
    const bgScale = 1.08; let bgW; let bgH;
    if (sourceRatio > targetRatio) { bgH = media.height * bgScale; bgW = bgH * sourceRatio; }
    else { bgW = media.width * bgScale; bgH = bgW / sourceRatio; }
    context.save(); context.globalAlpha = 0.35; applyFilter(context, slide?.filter || 'none', 18); context.drawImage(image, media.x + (media.width - bgW) / 2, media.y + (media.height - bgH) / 2, bgW, bgH); resetFilter(context); context.restore();
    context.fillStyle = 'rgba(4,4,7,0.16)'; context.fillRect(media.x, media.y, media.width, media.height);
  }

  if (appearance.reveal < 0.999) {
    const revealW = Math.max(1, media.width * clamp(appearance.reveal));
    const revealX = appearance.origin === 'center' ? media.x + (media.width - revealW) / 2 : media.x;
    context.save(); context.beginPath(); context.rect(revealX, media.y, revealW, media.height); context.clip(); applyFilter(context, slide?.filter || 'none'); context.drawImage(image, x, y, drawW, drawH); resetFilter(context); context.restore();
  } else { applyFilter(context, slide?.filter || 'none'); context.drawImage(image, x, y, drawW, drawH); resetFilter(context); }
  context.restore();
  context.restore();
}

function drawCaption(context, slide, progress, width, height) {
  const text = String(slide?.captionText || '').trim(); if (!text) return;
  const style = slide?.captionStyle || {};
  let opacity = 1; let offsetY = 0; let scale = 1;
  const intro = clamp(progress / 0.12); const outro = clamp((1 - progress) / 0.12);
  if (style.animation === 'slide-up') { opacity = intro; offsetY = (1 - intro) * 26; }
  else if (style.animation === 'zoom') { opacity = intro; scale = lerp(0.82, 1, intro); }
  else if (style.animation === 'typewriter') { opacity = intro; }
  else opacity = Math.min(intro, outro);
  const fontFamily = style.fontFamily === 'serif' ? 'Noto Serif' : style.fontFamily === 'mono' ? 'Noto Sans Mono' : style.fontFamily === 'display' ? 'Impact' : 'Noto Sans';
  const fontSize = Math.max(18, Math.round(38 * (Number(style.scale) || 1) * (width / 1920)));
  const shownText = style.animation === 'typewriter' ? text.slice(0, Math.max(1, Math.floor(text.length * clamp(progress / 0.45)))) : text;
  context.save(); context.globalAlpha = opacity; context.font = `700 ${fontSize}px ${fontFamily}`; context.textAlign = 'center'; context.textBaseline = 'middle';
  const lines = splitLines(context, shownText, width * 0.84); const lineHeight = Math.round(fontSize * 1.28); const totalHeight = lines.length * lineHeight; let y = height * 0.84;
  if (style.positionY === 'top') y = height * 0.16; else if (style.positionY === 'middle') y = height * 0.5;
  y += offsetY;
  context.translate(width / 2, y); context.scale(scale, scale); context.translate(-width / 2, -y);
  const maxWidth = Math.max(...lines.map((line) => context.measureText(line).width), 0); const padX = Math.round(fontSize * 0.7); const padY = Math.round(fontSize * 0.38);
  const background = hexToRgba(style.backgroundColor || '#00000088');
  if (background) { context.fillStyle = background; roundedRectPath(context, width / 2 - (maxWidth + padX * 2) / 2, y - (totalHeight + padY * 2) / 2, maxWidth + padX * 2, totalHeight + padY * 2, Math.min(16, fontSize * 0.35)); context.fill(); }
  context.fillStyle = style.color || '#ffffff'; lines.forEach((line, index) => context.fillText(line, width / 2, y - totalHeight / 2 + lineHeight * (index + 0.5)));
  context.restore();
}

export function drawSlide(context, slide, progress, width, height, imagesBySource) {
  context.clearRect(0, 0, width, height); context.fillStyle = slide?.layoutBackground || DEFAULT_BACKGROUND; context.fillRect(0, 0, width, height);
  const images = getSlideImages(slide); const cells = getLayoutCells(slide?.layout, width, height, slide?.layoutGap);
  for (let index = 0; index < Math.min(images.length, cells.length); index += 1) drawImageInCell(context, imagesBySource.get(images[index].src), slide, progress, cells[index], index, images.length);
  drawCaption(context, slide, progress, width, height);
}

function drawScaled(context, canvas, alpha, scale, tx = 0, ty = 0) {
  const width = canvas.width; const height = canvas.height; context.save(); context.globalAlpha = clamp(alpha); context.translate(width / 2 + tx, height / 2 + ty); context.scale(scale, scale); context.drawImage(canvas, -width / 2, -height / 2, width, height); context.restore();
}

export function composeTransition(context, outgoingCanvas, incomingCanvas, style, progress) {
  const width = outgoingCanvas.width; const height = outgoingCanvas.height; const p = easeInOut(progress); context.clearRect(0, 0, width, height);
  switch (style) {
    case 'slide-left': context.drawImage(outgoingCanvas, -width * p, 0); context.drawImage(incomingCanvas, width * (1 - p), 0); break;
    case 'slide-right': context.drawImage(outgoingCanvas, width * p, 0); context.drawImage(incomingCanvas, -width * (1 - p), 0); break;
    case 'slide-up': context.drawImage(outgoingCanvas, 0, -height * p); context.drawImage(incomingCanvas, 0, height * (1 - p)); break;
    case 'slide-down': context.drawImage(outgoingCanvas, 0, height * p); context.drawImage(incomingCanvas, 0, -height * (1 - p)); break;
    case 'wipe-left': context.drawImage(outgoingCanvas, 0, 0); context.save(); context.beginPath(); context.rect(0, 0, width * p, height); context.clip(); context.drawImage(incomingCanvas, 0, 0); context.restore(); break;
    case 'circle-wipe': context.drawImage(outgoingCanvas, 0, 0); context.save(); context.beginPath(); context.arc(width / 2, height / 2, Math.hypot(width, height) * p, 0, Math.PI * 2); context.clip(); context.drawImage(incomingCanvas, 0, 0); context.restore(); break;
    case 'blinds': context.drawImage(outgoingCanvas, 0, 0); context.save(); context.beginPath(); { const count = 12; const item = width / count; for (let index = 0; index < count; index += 1) context.rect(index * item, 0, item * p, height); } context.clip(); context.drawImage(incomingCanvas, 0, 0); context.restore(); break;
    case 'zoom': drawScaled(context, outgoingCanvas, 1 - p, lerp(1, 0.88, p)); drawScaled(context, incomingCanvas, p, lerp(1.12, 1, p)); break;
    case 'push-zoom': drawScaled(context, outgoingCanvas, 1 - p * 0.92, lerp(1, 1.16, p)); drawScaled(context, incomingCanvas, p, lerp(0.86, 1, p)); break;
    case 'whip-pan': drawScaled(context, outgoingCanvas, 1 - p * 0.5, 1.04, -width * p * 0.35); drawScaled(context, incomingCanvas, clamp((p - 0.12) / 0.88), 1.04, width * (1 - p) * 0.35); break;
    case 'split-reveal': context.drawImage(outgoingCanvas, 0, 0); context.save(); { const half = (width / 2) * p; context.beginPath(); context.rect(width / 2 - half, 0, half, height); context.rect(width / 2, 0, half, height); context.clip(); context.drawImage(incomingCanvas, 0, 0); } context.restore(); break;
    case 'blur-fade': context.drawImage(outgoingCanvas, 0, 0); context.save(); context.globalAlpha = p; applyFilter(context, 'none', Math.max(0, 10 * (1 - p))); context.drawImage(incomingCanvas, 0, 0); resetFilter(context); context.restore(); break;
    case 'flash-fade': context.drawImage(outgoingCanvas, 0, 0); context.save(); context.globalAlpha = p; context.drawImage(incomingCanvas, 0, 0); context.restore(); context.save(); context.fillStyle = `rgba(255,255,255,${Math.sin(p * Math.PI) * 0.42})`; context.fillRect(0, 0, width, height); context.restore(); break;
    case 'film-burn': context.drawImage(outgoingCanvas, 0, 0); context.save(); context.globalAlpha = p; context.drawImage(incomingCanvas, 0, 0); context.restore(); { const gradient = context.createLinearGradient(0, 0, width, height); gradient.addColorStop(0, `rgba(255,180,30,${Math.sin(p * Math.PI) * 0.32})`); gradient.addColorStop(0.52, `rgba(255,70,0,${Math.sin(p * Math.PI) * 0.22})`); gradient.addColorStop(1, 'rgba(255,0,0,0)'); context.fillStyle = gradient; context.fillRect(0, 0, width, height); } break;
    case 'fade':
    default: context.drawImage(outgoingCanvas, 0, 0); context.save(); context.globalAlpha = p; context.drawImage(incomingCanvas, 0, 0); context.restore(); break;
  }
}

export function drawParticles(context, effect, time, width, height, seed = 1) {
  if (!effect || effect === 'none') return;
  const count = effect === 'snow' ? 45 : effect === 'bubbles' ? 25 : 30; context.save();
  for (let index = 0; index < count; index += 1) {
    const sx = seededUnit(hashString(`${seed}:x:${index}`)); const sy = seededUnit(hashString(`${seed}:y:${index}`)); const speed = seededUnit(hashString(`${seed}:s:${index}`)); const radius = 1 + seededUnit(hashString(`${seed}:r:${index}`)) * (effect === 'bubbles' ? 7 : 3);
    if (effect === 'snow') { const y = ((sy * height + time * (28 + speed * 42)) % (height + 20)) - 10; const x = (sx * width + Math.sin(time * 0.8 + index) * 18 + width) % width; context.fillStyle = 'rgba(255,255,255,0.68)'; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); }
    else if (effect === 'bubbles') { const y = height - ((sy * height + time * (22 + speed * 34)) % (height + 30)); const x = (sx * width + Math.sin(time + index) * 22 + width) % width; context.strokeStyle = 'rgba(125,211,252,0.43)'; context.lineWidth = 1.2; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.stroke(); }
    else { const x = sx * width; const y = sy * height; const pulse = 0.5 + Math.abs(Math.sin(time * (1.4 + speed) + index)) * 0.5; const s = radius * pulse; context.strokeStyle = `rgba(255,255,255,${0.35 + pulse * 0.45})`; context.lineWidth = 1; context.beginPath(); context.moveTo(x - s * 2, y); context.lineTo(x + s * 2, y); context.moveTo(x, y - s * 2); context.lineTo(x, y + s * 2); context.stroke(); }
  }
  context.restore();
}

export function resolvedTransitionForSlide(slide, previous) { return resolveTransition(slide, previous); }
