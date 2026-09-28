// Finishing: turn an approved take into what a visitor streams. The picture is
// re-encoded once for the web (H.264, fast start) at its delivered size and at
// exactly half size; the sound is levelled so every film in a world plays at
// the same loudness; crossings also get a rewind (picture and sound reversed)
// for the Back button — rendered, because browsers cannot play video backwards.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ffmpeg, probe } from './media.js';
import { FFMPEG } from './media.js';
import { stderrOf } from './screen.js';

export const FILM_LUFS = -14;
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

/** Encode an approved take for the web: full size and exactly half size. */
export async function finishFilm(input, out, out720) {
  const info = await probe(input);
  mkdirSync(dirname(out), { recursive: true });
  const level = info.audioChannels ? await loudnormFilter(input, { lufs: FILM_LUFS }) : null;
  const audio = info.audioChannels ? [...(level ? ['-af', level] : []), ...AUDIO] : ['-an'];
  await ffmpeg(['-i', input, ...VIDEO, ...audio, out]);
  await ffmpeg(['-i', out, '-vf', `scale=${info.width / 2}:${info.height / 2}:flags=lanczos`, ...VIDEO, '-c:a', 'copy', out720]);
  return { width: info.width, height: info.height, seconds: +info.seconds.toFixed(3), frames: info.frames };
}

/**
 * The film backwards, picture and sound, for Back. The picture is reversed in
 * two-second pieces joined in reverse order, so memory stays bounded at 2K;
 * the sound is reversed whole (it is small).
 */
export async function rewindFilm(finished, out, out720, { segmentFrames = 48 } = {}) {
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
    const audio = info.audioChannels ? ['-i', finished, '-map', '0:v', '-map', '1:a', '-af', 'areverse', ...AUDIO] : ['-map', '0:v', '-an'];
    await ffmpeg(['-i', picture, ...audio, '-c:v', 'copy', '-movflags', '+faststart', '-shortest', out]);
    await ffmpeg(['-i', out, '-vf', `scale=${info.width / 2}:${info.height / 2}:flags=lanczos`, ...VIDEO, '-c:a', 'copy', out720]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
