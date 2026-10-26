// The world's preview loop, when the Kit already has one: the opening place's living photograph, if it can stand as
// the short, seamless, muted loop Sogni Worlds plays on a world's card (docs/hosting.md › Preview loop). Nothing is
// rendered or encoded for it: a film that does not qualify is simply not named.
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { filmIssues } from './delivery.js';
import { probe } from './media.js';
import { analyseFrames, greyFrames } from './screen.js';
import { isRemote } from './worldjson.js';

/** What a preview loop must be, from the gallery's spec: 4 to 15 s, 16:9, under 10 MB. */
export const PREVIEW = Object.freeze({ minSeconds: 4, maxSeconds: 15, aspect: 16 / 9, maxBytes: 10 * 1024 * 1024 });
/** How far a film's shape may be from 16:9 (the Kit's 16:9 canvas, 1344 × 768, is 1.6% off it). */
const SHAPE_TOLERANCE = 0.02;

/**
 * Does the film really loop? Its last frame must match its first the way the Kit judges a loop's ends (analyseFrames:
 * a correlation of 0.9 or more), with no brightness flash at the seam.
 */
export async function loopsSeamlessly(path) {
  const frames = await greyFrames(path);
  if (!frames.length) return false;
  const { flags } = analyseFrames(frames, { kind: 'loop', from: frames[0], to: frames[0] });
  return !flags.some(flag => ['too-short', 'end-mismatch', 'seam-flash'].includes(flag.code));
}

/**
 * The opening place's loop as the world's preview, from `dir` (a build folder or an export): its phone copy first,
 * the smaller file. Returns { preview: { ref, width, height } } or { preview: null, why } saying why none qualifies.
 */
export async function previewLoop(world, dir) {
  const loop = world.places?.find(place => place.id === world.start)?.loop;
  if (!loop) return { preview: null, why: 'the opening place has no living-photo loop' };
  let why = null;
  for (const ref of [loop.src720, loop.src].filter(Boolean)) {
    const { reason, film } = await qualify(ref, dir);
    if (!reason) return { preview: { ref, width: film.width, height: film.height } };
    why ??= `the opening place's loop (${ref}) ${reason}`;
  }
  return { preview: null, why };
}

/** { reason } why a served film cannot be the preview loop, or { film } (its probe) when it can. */
async function qualify(ref, dir) {
  if (isRemote(ref)) return { reason: 'streams from another host' };
  const path = resolve(dir, ref);
  if (!path.startsWith(resolve(dir) + sep)) return { reason: 'is outside the world\'s folder' };
  let bytes;
  try { bytes = statSync(path).size; } catch { return { reason: 'is missing' }; }
  if ((await filmIssues(path, ref)).length) return { reason: 'is not in the Kit\'s film profile (build the world again)' };
  const film = await probe(path);
  if (Math.abs(Math.log(film.width / film.height / PREVIEW.aspect)) > SHAPE_TOLERANCE) return { reason: `is ${film.width}×${film.height}, not 16:9` };
  if (film.seconds < PREVIEW.minSeconds || film.seconds > PREVIEW.maxSeconds) return { reason: `runs ${film.seconds.toFixed(1)} s; a preview runs ${PREVIEW.minSeconds} to ${PREVIEW.maxSeconds} s` };
  if (bytes >= PREVIEW.maxBytes) return { reason: `is ${(bytes / 1024 / 1024).toFixed(1)} MB; a preview is under 10 MB` };
  if (!(await loopsSeamlessly(path))) return { reason: 'does not end on its first frame, so it would jump where it loops' };
  return { film };
}
