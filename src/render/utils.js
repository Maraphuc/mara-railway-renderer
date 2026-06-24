export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (start, end, amount) => start + (end - start) * amount;
export const easeInOut = (value) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (value) => 1 - Math.pow(1 - clamp(value), 3);
export const easeInCubic = (value) => Math.pow(clamp(value), 3);

export function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededUnit(seed) {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

export function safeNumber(raw, fallback, min = -Infinity, max = Infinity) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function safeFilename(value) {
  return String(value || 'asset.bin').split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function hexToRgba(value, fallback = 'rgba(0,0,0,0.55)') {
  if (!value || value === 'none') return null;
  if (value.startsWith('rgba(') || value.startsWith('rgb(') || value.startsWith('#')) return value;
  return fallback;
}

export function roundedRectPath(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export function splitLines(context, text, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
