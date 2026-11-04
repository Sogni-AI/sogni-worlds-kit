// Seedance 2.5 on Sogni: an opt-in film model for the shots MiniMax H3 can't
// carry well (several people talking, fast physical action, one thing causing
// another in a set order). It runs in its first-and-last-frame mode, so a
// Seedance film starts and lands on the same canonical stills as every H3 film,
// and it makes its own dialogue and sound. It is a premium model: an Unlimited
// plan does not cover it, so it always pays in tokens and is quoted first.
// docs/directing-films.md › Seedance 2.5 says when to use it.
import sharp from 'sharp';
import { assemblePrompt, cameraSentence, EARLIER_LANDINGS, LANDING, landingSentence, LOOP_LANDING, ON_ONE_STILL } from './h3.js';

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
 *
 * `draft` is the 480p size of the same shape, from Sogni's own size list for
 * Seedance 2.5 (as of 2026-11): every take is rendered at it first, as a draft.
 */
export const SHAPES = Object.freeze([
  { ratio: '16:9', width: 1920, height: 1080, draft: { width: 854, height: 480 } },
  { ratio: '4:3', width: 1664, height: 1248, draft: { width: 752, height: 560 } },
  { ratio: '1:1', width: 1440, height: 1440, draft: { width: 640, height: 640 } },
  { ratio: '3:4', width: 1248, height: 1664, draft: { width: 560, height: 752 } },
  { ratio: '9:16', width: 1080, height: 1920, draft: { width: 480, height: 854 } },
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
  return best && best.off <= Math.log(1 + ASPECT_TOLERANCE) ? { ratio: best.ratio, width: best.width, height: best.height, draft: best.draft } : null;
}

/*
 * Drafts. Every Seedance take is rendered as a 480p draft (`seedanceDraft`),
 * priced like any 480p take, so a film is judged and retaken cheaply. The take
 * the person approves is then finalized: Sogni renders that same video again
 * at 1080p (`seedanceDraftJobId`) from the draft's own prompt, stills, length,
 * seed and sound. Only a take submitted as a draft can be finalized, only for a
 * while after it finished (Sogni says until when), and each finalize is billed.
 */

/** A take rendered as a draft, to be finalized at 1080p once approved. */
export const isDraft = journal => journal?.seedanceDraft === true;

/** A date as the person reads it. */
export const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Why a draft can't be finalized now, in plain words, or null when it can.
 * Sogni reports the deadline with the finished draft; without one there is
 * nothing to finalize.
 */
export function draftLapsed(journal, now = Date.now()) {
  const deadline = Date.parse(journal?.draftExpiresAt ?? '');
  if (!journal?.draftJobId || !Number.isFinite(deadline)) return 'Sogni did not report it as a draft that can be made at 1080p';
  if (deadline <= now) return `it could be made at 1080p only until ${when(journal.draftExpiresAt)}`;
  return null;
}

/** A still, resized to the shape Seedance renders (never cropped), as the bytes to send. */
export const fitStill = (bytes, shape) => sharp(bytes).resize(shape.width, shape.height, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();

/** H3's landing sentences (h3.js), said in the words Seedance reads. */
export const LAST = 'At the end of the shot the camera arrives on the framing of the last frame, with everyone and everything in the places and poses the last frame shows.';
export const LOOP_LAST = 'Everything keeps moving to the end of the shot and arrives back on the places and poses the last frame shows.';
/** The old landing sentence, after Picture 2 became "the last frame": a direction that ends on it keeps its prompt. */
const OLD_LAST = /established by the last frame/;

/**
 * The prompt sent to Seedance, from the same `action`, `sound`, `landing` and
 * `camera` an H3 film has. The plan's own words are kept; only the kit's
 * markup is said the way Seedance reads it: Picture 1 and Picture 2 are its
 * first and last frames, a spoken line `<d>[English] …</d>` is quoted speech,
 * and a film on one still gets the camera an H3 loop gets (locked, unless it
 * writes its own).
 */
export function assembleSeedancePrompt(film) {
  const frames = text => String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/<d>\[English\]\s*([\s\S]*?)<\/d>/g, '"$1"')
    .replace(/\bPicture 1\b/g, 'the first frame').replace(/\bPicture 2\b/g, 'the last frame');
  const oneStill = ON_ONE_STILL.has(film.kind);
  const action = frames(film.action);
  const landing = frames(landingSentence({ ...film, action }, { kit: oneStill ? LOOP_LAST : LAST, old: OLD_LAST }));
  const body = [
    oneStill ? `The first frame and the last frame are the same photograph. ${frames(cameraSentence(film))}` : '',
    action,
    landing,
  ].filter(Boolean).join(' ');
  return `${body}\n\nSound: ${frames(film.sound)}`;
}

/** The prompt a film is rendered with, by its model. */
export const filmPrompt = film => (isSeedance(film.model) ? assembleSeedancePrompt(film) : assemblePrompt(film));

/** Every landing sentence the kit has written itself, on either model, then and now. */
const KIT_LANDINGS = [LANDING, LOOP_LANDING, LAST, LOOP_LAST, ...EARLIER_LANDINGS, ...EARLIER_LANDINGS.map(s => s.replace('Picture 2', 'the last frame'))];

/**
 * A prompt without the kit's own landing sentence: what the plan's words
 * asked for. When the kit's sentence changes, a rejected film whose words did
 * not is still the same direction, and a retake still needs new words.
 */
export const directionWords = prompt => KIT_LANDINGS.reduce((text, sentence) => text.split(sentence).join(''), String(prompt ?? '')).replace(/\s+/g, ' ').trim();
