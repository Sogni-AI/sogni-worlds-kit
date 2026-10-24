// Seedance 2.5 on Sogni: an opt-in film model for the shots MiniMax H3 can't
// carry well (several people talking, fast physical action, one thing causing
// another in a set order). It runs in its first-and-last-frame mode, so a
// Seedance film starts and lands on the same canonical stills as every H3 film,
// and it makes its own dialogue and sound. It is a premium model: an Unlimited
// plan does not cover it, so it always pays in tokens and is quoted first.
// docs/directing-films.md › Seedance 2.5 says when to use it.
import sharp from 'sharp';
import { assemblePrompt, LOCKED_CAMERA, ON_ONE_STILL } from './h3.js';

export const SEEDANCE_MODELS = Object.freeze(['seedance-2-5', 'seedance-2-5-uncensored']);
export const isSeedance = model => SEEDANCE_MODELS.includes(model);
/** The models a film may name in `model`. Leaving it out means MiniMax H3. */
export const FILM_MODELS = Object.freeze(['minimax-h3', ...SEEDANCE_MODELS]);

/** Seedance renders whole seconds at 24 fps, 4 to 30 of them, and returns seconds × 24 + 1 frames. */
export const SECONDS = Object.freeze({ min: 4, max: 30 });
export const isSeedanceFrames = frames => Number.isInteger(frames) && (frames - 1) % 24 === 0
  && (frames - 1) / 24 >= SECONDS.min && (frames - 1) / 24 <= SECONDS.max;
export const seedanceSeconds = frames => (frames - 1) / 24;
export const SEEDANCE_FRAMES = Array.from({ length: SECONDS.max - SECONDS.min + 1 }, (_, i) => (SECONDS.min + i) * 24 + 1);
/** A Seedance loop's length when the plan gives none: 5 s. */
export const SEEDANCE_LOOP_FRAMES = 121;

/**
 * The 1080p shapes Seedance 2.5 renders. A world's canvas can use Seedance
 * when its shape is within ASPECT_TOLERANCE of one of them: each still is
 * resized to that shape (a squeeze of at most 2%, too small to see) before it
 * is sent, and `build` sizes the film back onto the world's canvas, so the film
 * and the stills line up exactly. A 3:2 or 2:3 world is 11% away from any of
 * them: a squeeze that size changes how people look, so it is refused.
 */
export const SHAPES = Object.freeze([
  { ratio: '16:9', width: 1920, height: 1080 },
  { ratio: '4:3', width: 1664, height: 1248 },
  { ratio: '1:1', width: 1440, height: 1440 },
  { ratio: '3:4', width: 1248, height: 1664 },
  { ratio: '9:16', width: 1080, height: 1920 },
]);
export const ASPECT_TOLERANCE = 0.02;

/** The Seedance shape for a canvas, or null when none is close enough. */
export function shapeFor(canvas) {
  const aspect = canvas.width / canvas.height;
  let best = null;
  for (const shape of SHAPES) {
    const off = Math.abs(Math.log(aspect / (shape.width / shape.height)));
    if (!best || off < best.off) best = { ...shape, off };
  }
  return best && best.off <= Math.log(1 + ASPECT_TOLERANCE) ? { ratio: best.ratio, width: best.width, height: best.height } : null;
}

/** A still, resized to the shape Seedance renders (never cropped), as the bytes to send. */
export const fitStill = (bytes, shape) => sharp(bytes).resize(shape.width, shape.height, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();

const LAST = 'The camera settles into the pose, spacing and composition established by the last frame at the end of the shot.';
const LOOP_LAST = 'The motion settles into the pose, spacing and composition established by the last frame at the end of the shot.';

/**
 * The prompt sent to Seedance, from the same `action` and `sound` an H3 film
 * has. The plan's own words are kept; only the kit's markup is said the way
 * Seedance reads it: Picture 1 and Picture 2 are its first and last frames, a
 * spoken line `<d>[English] …</d>` is quoted speech, and a film on one still
 * gets the same locked camera an H3 loop gets.
 */
export function assembleSeedancePrompt({ kind, action, sound }) {
  const frames = text => String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/<d>\[English\]\s*([\s\S]*?)<\/d>/g, '"$1"')
    .replace(/\bPicture 1\b/g, 'the first frame').replace(/\bPicture 2\b/g, 'the last frame');
  const oneStill = ON_ONE_STILL.has(kind);
  let body = frames(action);
  if (!/established by the last frame/.test(body)) body = `${body} ${oneStill ? LOOP_LAST : LAST}`;
  if (oneStill) body = `The first frame and the last frame are the same photograph. ${frames(LOCKED_CAMERA)} ${body}`;
  return `${body}\n\nSound: ${frames(sound)}`;
}

/** The prompt a film is rendered with, by its model. */
export const filmPrompt = film => (isSeedance(film.model) ? assembleSeedancePrompt(film) : assemblePrompt(film));
