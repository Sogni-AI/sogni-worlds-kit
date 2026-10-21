// Finishing: turn an approved take into what a visitor streams. The picture is
// re-encoded once for the web (H.264, fast start) at its delivered size and at
// exactly half size; the sound is levelled into one mix: every film and loop
// at one scene level, six below the narrator's voice (rain levelled to the
// voice's loudness drowns it), so nothing jumps where a film hands over to a loop.
// Crossings also get a rewind (picture and sound reversed) for the Back
// button — rendered, because browsers cannot play video backwards.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ffmpeg, probe } from './media.js';
import { FFMPEG } from './media.js';
import { stderrOf } from './screen.js';

/**
 * Every film and loop: the world's scene sound, 6 LU under the narrator
 * (narrate.js NARRATION_LUFS, -16), the same on both sides of every handover
 * between a film and a loop. The player lowers a loop further while the narrator speaks.
 */
export const FILM_LUFS = -22;
export const FILM_TRUE_PEAK = -1.5;
const VIDEO = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'];

/**
 * The loudnorm filter for a target, measured first so the second pass applies
 * one linear gain (two-pass loudnorm: accurate, and it never pumps).
 */
export async function loudnormFilter(input, { lufs, truePeak = FILM_TRUE_PEAK, lra = 11 }) {
  const log = await stderrOf(FFMPEG, ['-hide_banner', '-nostats', '-nostdin', '-i', input, '-af',
    `loudnorm=I=${lufs}:TP=${truePeak}:LRA=${lra}:print_format=json`, '-f', 'null', '-']);
  const json = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  if (!Number.isFinite(Number(json.input_i)) || Number(json.input_i) < -70) {
    return null; // silence: nothing to level
  }
  return `loudnorm=I=${lufs}:TP=${truePeak}:LRA=${lra}:measured_I=${json.input_i}:measured_TP=${json.input_tp}`
    + `:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`;
}

/** Encode an approved take for the web: full size and exactly half size, its sound at `lufs`. */
export async function finishFilm(input, out, out720, { lufs = FILM_LUFS } = {}) {
  const info = await probe(input);
  mkdirSync(dirname(out), { recursive: true });
  const level = info.audioChannels ? await loudnormFilter(input, { lufs }) : null;
  const audio = info.audioChannels ? [...(level ? ['-af', level] : []), ...AUDIO] : ['-an'];
  await ffmpeg(['-i', input, ...VIDEO, ...audio, out]);
  await ffmpeg(['-i', out, '-vf', `scale=${info.width / 2}:${info.height / 2}:flags=lanczos`, ...VIDEO, '-c:a', 'copy', out720]);
  return { width: info.width, height: info.height, seconds: +info.seconds.toFixed(3), frames: info.frames };
}

/**
 * The film backwards, for Back (picture and sound reversed) and for putting a
 * close look's object back (`sound: 'forward'`: a room's sound and a set-down
 * read naturally forwards, a reversed creak does not). The picture is
 * reversed in two-second pieces joined in reverse order, so memory stays
 * bounded at 2K; the sound is reversed whole (it is small).
 */
export async function rewindFilm(finished, out, out720, { segmentFrames = 48, sound = 'reverse' } = {}) {
  const info = await probe(finished);
  const work = join(dirname(out), `.rewind-${basename(out, '.mp4')}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const pieces = [];
    for (let start = 0, index = 0; start < info.frames; start += segmentFrames, index++) {
      const count = Math.min(segmentFrames, info.frames - start);
      const piece = join(work, `piece-${String(index).padStart(4, '0')}.mp4`);
      await ffmpeg(['-i', finished, '-vf', `trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,reverse`, '-an', ...VIDEO, piece]);
      pieces.push(piece);
    }
    const list = join(work, 'list.txt');
    writeFileSync(list, pieces.reverse().map(piece => `file '${piece.replace(/'/g, "'\\''")}'`).join('\n'));
    const picture = join(work, 'picture.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', picture]);
    // The sound: reversed, forwards, or another file's (a place's loop: its room carries on under the film).
    // Another file's sound repeats if it is shorter and is cut at the picture's end: the picture sets the length.
    const own = sound === 'reverse' || sound === 'forward';
    const audio = own
      ? (info.audioChannels ? ['-i', finished, '-map', '0:v', '-map', '1:a', ...(sound === 'reverse' ? ['-af', 'areverse'] : []), ...AUDIO] : ['-map', '0:v', '-an'])
      : ['-stream_loop', '-1', '-i', sound, '-map', '0:v', '-map', '1:a?', ...AUDIO, '-t', String(info.seconds)];
    await ffmpeg(['-i', picture, ...audio, '-c:v', 'copy', '-movflags', '+faststart', ...(own ? ['-shortest'] : []), out]);
    if (out720) await ffmpeg(['-i', out, '-vf', `scale=${info.width / 2}:${info.height / 2}:flags=lanczos`, ...VIDEO, '-c:a', 'copy', out720]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Level a finished film's sound again in place, keeping its picture as it is
 * (a new level is seconds of audio work, not a re-encode of the picture).
 */
export async function relevelFilm(file, lufs) {
  const info = await probe(file);
  if (!info.audioChannels) return;
  const level = await loudnormFilter(file, { lufs });
  if (!level) return;
  const tmp = `${file}.level.mp4`;
  await ffmpeg(['-i', file, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', level, ...AUDIO, '-movflags', '+faststart', tmp]);
  renameSync(tmp, file);
}

/** Level an audio file to a loudness and write an MP3. */
export async function levelAudio(input, out, { lufs, truePeak = -1.5, bitrate = '160k', mono = false, sampleRate = 44100 }) {
  mkdirSync(dirname(out), { recursive: true });
  const level = await loudnormFilter(input, { lufs, truePeak });
  await ffmpeg(['-i', input, '-vn', ...(level ? ['-af', level] : []), '-ar', String(sampleRate), ...(mono ? ['-ac', '1'] : []),
    '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', bitrate, '-write_xing', '1', out]);
}

/** Remove stray partial rewind folders from an interrupted build. */
export function cleanPartials(dir) {
  try {
    for (const name of readdirSync(dir)) if (name.startsWith('.rewind-')) rmSync(join(dir, name), { recursive: true, force: true });
  } catch { /* nothing to clean */ }
}
