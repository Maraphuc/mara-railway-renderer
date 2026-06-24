import { clamp, hashString, safeNumber } from './utils.js';

const RANDOM_TRANSITIONS = [
  'fade',
  'blur-fade',
  'flash-fade',
  'film-burn',
  'push-zoom',
  'whip-pan',
  'split-reveal',
  'slide-left',
  'slide-right',
  'wipe-left',
];

const RANDOM_MOTIONS = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
  'diagonal-left',
  'diagonal-right',
  'zoom-pan',
  'sway',
];

export function calculateProjectDuration(slides) {
  return (Array.isArray(slides) ? slides : []).reduce(
    (total, slide) => total + Math.max(1, safeNumber(slide?.duration, 4, 1, 120)),
    0,
  );
}

export function buildTimeline(slides) {
  const list = Array.isArray(slides) ? slides : [];
  let cursor = 0;
  return list.map((slide, index) => {
    const duration = Math.max(1, safeNumber(slide.duration, 4, 1, 120));
    const transitionDuration = index === list.length - 1
      ? 0
      : Math.min(duration, Math.max(0.1, safeNumber(slide.transitionDuration, 1.5, 0.1, 8)));
    const item = {
      index,
      slide,
      start: cursor,
      displayEnd: cursor + duration,
      renderEnd: cursor + duration + transitionDuration,
      duration,
      transitionDuration,
    };
    cursor += duration;
    return item;
  });
}

export function resolveTransition(slide, previousStyle = null) {
  const configured = slide?.transitionStyle || 'fade';
  if (configured !== 'random') return configured;
  const seed = Number.isFinite(Number(slide?.transitionSeed))
    ? Number(slide.transitionSeed)
    : hashString(`${slide?.id || 'slide'}:transition`);
  let style = RANDOM_TRANSITIONS[Math.abs(seed) % RANDOM_TRANSITIONS.length];
  if (style === previousStyle) {
    style = RANDOM_TRANSITIONS[(Math.abs(seed) + 1) % RANDOM_TRANSITIONS.length];
  }
  return style;
}

export function resolveMotion(slide, imageIndex = 0) {
  const configured = slide?.kenBurns || 'none';
  if (configured !== 'cinematic-random') return configured;
  const seed = Number.isFinite(Number(slide?.motionSeed))
    ? Number(slide.motionSeed)
    : hashString(`${slide?.id || 'slide'}:motion`);
  return RANDOM_MOTIONS[Math.abs(seed + imageIndex * 7) % RANDOM_MOTIONS.length];
}

export function getFrameState(timeline, timeSeconds) {
  if (!timeline.length) return { current: null, previous: null, transition: null };
  const last = timeline[timeline.length - 1];
  const safeTime = clamp(timeSeconds, 0, Math.max(0, last.displayEnd - 0.00001));
  let currentIndex = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index].start <= safeTime) currentIndex = index;
    else break;
  }
  const current = timeline[currentIndex];
  const previous = currentIndex > 0 ? timeline[currentIndex - 1] : null;
  if (previous && safeTime >= previous.displayEnd && safeTime < previous.renderEnd) {
    const progress = clamp((safeTime - previous.displayEnd) / Math.max(0.001, previous.transitionDuration));
    return {
      current,
      previous,
      transition: {
        progress,
        outgoing: previous,
        incoming: current,
      },
    };
  }
  return { current, previous: null, transition: null };
}

export function slideProgress(item, timeSeconds) {
  if (!item) return 0;
  return clamp((timeSeconds - item.start) / Math.max(0.001, item.duration));
}
