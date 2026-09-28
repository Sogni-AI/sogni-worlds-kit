// MiniMax H3 on Sogni: the one video recipe every world film uses, and the
// prompt document it expects. Rules here come from MiniMax's own Base prompt
// guide and from what held up across three published worlds (see
// docs/directing-films.md for the reasons).

/**
 * FastH3 first-and-last-frame, two-stage. The first and last frames of every
 * film are pinned to real stills, so a crossing starts exactly on one place and
 * lands exactly on the next. Two-stage renders the canvas and delivers twice
 * its width and height (a 1152×768 canvas arrives as 2304×1536).
 */
export const MODEL = 'minimax-h3-fastvideo-int8_flf2v_turbo_2stage';
export const FPS = 24;
export const STEPS = 4;
export const GUIDANCE = 1;
export const NETWORK = 'fast';

/** H3 frame counts sit on a 124 + 17n grid: 124 (5.17 s) to 362 (15.08 s). */
export const FRAMES = Object.freeze({ min: 124, max: 362, step: 17 });
export const LOOP_FRAMES = 192; // 8.00 s, the living-photograph length

/** The largest canvas H3 accepts, in pixels (1344 × 768). */
export const PIXEL_BUDGET = 1_032_192;

/**
 * Canvases that fit the budget, multiples of 32, one per common photo shape.
 * The delivered film is twice each side.
 */
export const CANVASES = Object.freeze([
  { name: '16:9', width: 1344, height: 768 },
  { name: '3:2', width: 1152, height: 768 },
  { name: '4:3', width: 1152, height: 864 },
  { name: '1:1', width: 992, height: 992 },
  { name: '3:4', width: 864, height: 1152 },
  { name: '2:3', width: 768, height: 1152 },
  { name: '9:16', width: 768, height: 1344 },
]);

export const isValidFrames = frames =>
  Number.isInteger(frames) && frames >= FRAMES.min && frames <= FRAMES.max && (frames - FRAMES.min) % FRAMES.step === 0;

/** The nearest valid frame count to a length in seconds. */
export function framesFor(seconds) {
  const steps = Math.round((seconds * FPS - FRAMES.min) / FRAMES.step);
  return Math.min(FRAMES.max, Math.max(FRAMES.min, FRAMES.min + steps * FRAMES.step));
}

export const secondsOf = frames => frames / FPS;

/** Every valid frame count, for help text and errors. */
export const VALID_FRAMES = Array.from({ length: (FRAMES.max - FRAMES.min) / FRAMES.step + 1 }, (_, i) => FRAMES.min + i * FRAMES.step);

/** The canvas whose shape is closest to a photo's, so the crop is smallest. */
export function canvasFor(width, height) {
  const aspect = width / height;
  let best = CANVASES[0];
  for (const canvas of CANVASES) {
    if (Math.abs(Math.log(canvas.width / canvas.height / aspect)) < Math.abs(Math.log(best.width / best.height / aspect))) best = canvas;
  }
  return best;
}

export function canvasByName(name) {
  const canvas = CANVASES.find(c => c.name === name || `${c.width}x${c.height}` === name);
  if (!canvas) throw new Error(`Unknown canvas "${name}". Use one of: ${CANVASES.map(c => `${c.name} (${c.width}x${c.height})`).join(', ')}`);
  return canvas;
}

export const delivered = canvas => ({ width: canvas.width * 2, height: canvas.height * 2 });

/**
 * MiniMax's first line for a first-and-last-frame film. With keyframes, every
 * picture is listed at its mark in time order: Picture 1 at 0, the keyframes
 * as Pictures 3, 4, … and Picture 2 at the last frame. Worlds use one shot.
 */
export function alignmentLine(frames, keyframeFrames = []) {
  const end = secondsOf(frames);
  if (!keyframeFrames.length) {
    return 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; '
      + `Picture 2 (from Shot 1) aligns with the ${end.toFixed(2)}-second mark of the target video.`;
  }
  const pictures = [
    { picture: 1, seconds: 0 },
    ...[...keyframeFrames].sort((a, b) => a - b).map((frame, index) => ({ picture: 3 + index, seconds: frame / FPS })),
    { picture: 2, seconds: end },
  ];
  return 'How the reference pictures align with the target video — '
    + pictures.map(({ picture, seconds }) => `Picture ${picture} (from Shot 1) aligns with the ${seconds.toFixed(2)}-second mark of the target video`).join('; ')
    + '.';
}

/** The phrase every direction opens from, tying the first frame to Picture 1. */
export const OPENING = 'begins in the position and framing established by Picture 1';
/** Appended to a crossing's direction when it does not already land on Picture 2. */
export const LANDING = 'The camera settles into the pose, spacing and composition established by Picture 2 at the end of the shot.';
/** Loops and moments start and end on the same still: the motion settles, not the camera. */
export const LOOP_LANDING = 'The motion settles into the pose, spacing and composition established by Picture 2 at the end of the shot.';

/**
 * The full document sent to H3, assembled from a film's `action` (what the
 * camera and the picture do, as one continuous shot) and `sound` (what is
 * heard). Agents write only those two; the format around them is fixed here.
 */
export function assemblePrompt({ kind, frames, action, sound, keyframes = [] }) {
  const landing = kind === 'crossing' ? LANDING : LOOP_LANDING;
  let body = String(action ?? '').replace(/\s+/g, ' ').trim();
  if (!/established by Picture 2/.test(body)) body = `${body} ${landing}`;
  return [
    alignmentLine(frames, keyframes.map(k => k.frame)),
    '',
    `integrated_multimodal_description: [Shot 1] ${body}`,
    '',
    `overall_soundscape: ${String(sound ?? '').replace(/\s+/g, ' ').trim()}`,
    '',
    'non_diegetic_music: N/A',
  ].join('\n');
}

/** H3 reads at most this many characters of a prompt. */
export const PROMPT_LIMIT = 7000;
