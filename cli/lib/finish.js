// Finishing: turn an approved take into what a visitor streams. The picture is
// re-encoded once for the web at its delivered size and at exactly half size,
// through Sogni's streaming profile (delivery.js: H.264 CRF 23, the bitrate
// capped by size, a keyframe every 2 s, fast start); the sound is levelled
// into one mix: every film and loop
// at one scene level, six below the narrator's voice (rain levelled to the
// voice's loudness drowns it), so nothing jumps where a film hands over to a loop.
// Crossings also get a rewind (picture and sound reversed) for the Back
// button — rendered, because browsers cannot play video backwards.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ffmpeg, probe } from './media.js';
import { FFMPEG } from './media.js';
import { videoArgs } from './delivery.js';
import { stderrOf } from './screen.js';
import { pushInFrames } from './pushin.js';

/**
 * Every film and loop: the world's scene sound, 6 LU under the narrator
 * (narrate.js NARRATION_LUFS, -16), the same on both sides of every handover
 * between a film and a loop. The player lowers a loop further while the narrator speaks.
 */
export const FILM_LUFS = -22;
export const FILM_TRUE_PEAK = -1.5;
/** The rewind's reversed pieces before they are joined: lossless, so the one encode of the whole picture is its only loss. */
const LOSSLESS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p'];
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

/**
 * Encode an approved take for the web: full size and exactly half size, its
 * sound at `lufs`. `size` sizes a film rendered at another size (Seedance's
 * own shape) onto the world's canvas, so it lines up with the stills exactly.
 * `pushIn` ({ still, at, zoom, frames }) puts a crossing's push-in in front of
 * the film: from the whole still onto the crop the film was rendered from, its
 * sound starting with the film.
 */
export async function finishFilm(input, out, out720, { lufs = FILM_LUFS, size = null, pushIn = null } = {}) {
  const info = await probe(input);
  mkdirSync(dirname(out), { recursive: true });
  const level = info.audioChannels ? await loudnormFilter(input, { lufs }) : null;
  const target = size ?? { width: info.width, height: info.height };
  const resize = target.width !== info.width || target.height !== info.height;
  if (!resize && !pushIn) {
    const audio = info.audioChannels ? [...(level ? ['-af', level] : []), ...AUDIO] : ['-an'];
    await ffmpeg(['-i', input, ...videoArgs(info), ...audio, out]);
    await ffmpeg(['-i', out, '-vf', `scale=${info.width / 2}:${info.height / 2}:flags=lanczos`, ...videoArgs({ width: info.width / 2, height: info.height / 2, fps: info.fps }), '-c:a', 'copy', out720]);
    return { width: info.width, height: info.height, seconds: +info.seconds.toFixed(3), frames: info.frames };
  }
  const fit = `scale=${target.width}:${target.height}:flags=lanczos`;
  if (!pushIn) {
    const audio = info.audioChannels ? [...(level ? ['-af', level] : []), ...AUDIO] : ['-an'];
    await ffmpeg(['-i', input, '-vf', `${fit},setsar=1`, ...videoArgs({ ...target, fps: info.fps }), ...audio, out]);
  } else {
    const work = join(dirname(out), `.pushin-${basename(out, '.mp4')}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const count = await pushInFrames(pushIn.still, pushIn, target, (k, png) => writeFileSync(join(work, `${String(k).padStart(3, '0')}.png`), png));
      const lead = Math.round(count / 24 * 1000);
      // One colour space on both sides of the join (a still's RGB as BT.709 limited range, the film's own), or the push-in shifts colour where the film takes over.
      const tags = 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
      const graph = [`[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${tags}[a]`, `[1:v]${fit}:out_range=tv,setsar=1,format=yuv420p,${tags}[b]`, `[a][b]concat=n=2:v=1:a=0[v]`];
      if (info.audioChannels) graph.push(`[1:a]adelay=${lead}:all=1,apad${level ? `,${level}` : ''}[aud]`);
      await ffmpeg(['-framerate', '24', '-i', join(work, '%03d.png'), '-i', input, '-filter_complex', graph.join(';'), '-map', '[v]',
        ...(info.audioChannels ? ['-map', '[aud]', '-shortest', ...AUDIO] : ['-an']), ...videoArgs({ ...target, fps: 24 }), out]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  await ffmpeg(['-i', out, '-vf', `scale=${target.width / 2}:${target.height / 2}:flags=lanczos`, ...videoArgs({ width: target.width / 2, height: target.height / 2, fps: pushIn ? 24 : info.fps }), '-c:a', 'copy', out720]);
  const done = await probe(out);
  return { width: done.width, height: done.height, seconds: +done.seconds.toFixed(3), frames: done.frames };
}

/**
 * The film backwards, for Back (picture and sound reversed) and for putting a
 * close look's object back (`sound: 'forward'`: a room's sound and a set-down
 * read naturally forwards, a reversed creak does not). The picture is
 * reversed in two-second pieces joined in reverse order, so memory stays
 * bounded at 2K; the pieces are lossless and the joined picture is encoded
 * once, whole, so its bitrate stays inside the cap across every join. The
 * sound is reversed whole (it is small).
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
      await ffmpeg(['-i', finished, '-vf', `trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,reverse`, '-an', ...LOSSLESS, piece]);
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
    await ffmpeg(['-i', picture, ...audio, ...videoArgs(info), ...(own ? ['-shortest'] : []), out]);
    if (out720) await ffmpeg(['-i', out, '-vf', `scale=${info.width / 2}:${info.height / 2}:flags=lanczos`, ...videoArgs({ width: info.width / 2, height: info.height / 2, fps: info.fps }), '-c:a', 'copy', out720]);
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
    for (const name of readdirSync(dir)) if (name.startsWith('.rewind-') || name.startsWith('.pushin-')) rmSync(join(dir, name), { recursive: true, force: true });
  } catch { /* nothing to clean */ }
}
