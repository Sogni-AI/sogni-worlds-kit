// Automatic checks on a finished take, for the defects that get a film rejected
// on sight: a dissolve or crossfade between two pictures, a hard cut, a
// structure break, a film that does not start or land on its stills, a frozen
// tail, a flash at a loop's seam, silence. The numbers are a screen, not a
// verdict — they say where to look. The detectors are the ones that screened
// The Long White Cloud's 57 films; each flag names the frame to inspect.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FFMPEG, run, probe } from './media.js';
import { FPS } from './h3.js';

export const W = 96;
export const H = 64;
const PIXELS = W * H;

/** Every frame of a video as W×H greyscale bytes. */
export async function greyFrames(video, width = W, height = H) {
  const bytes = await run(FFMPEG, ['-v', 'error', '-nostdin', '-i', video, '-vf', `scale=${width}:${height}:flags=area`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  const size = width * height;
  const count = Math.floor(bytes.length / size);
  return Array.from({ length: count }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
}

/** A still as W×H greyscale bytes, squashed the same way as the frames. */
export async function greyStill(path, width = W, height = H) {
  return sharp(path).resize(width, height, { fit: 'fill', kernel: 'cubic' }).greyscale().raw().toBuffer();
}

export const mad = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

/** Pearson correlation of two equally sized pictures (1 = the same picture). */
export function correlation(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return da === db ? 1 : 0;
  return num / Math.sqrt(da * db);
}

const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
const sortedAt = (values, q) => { const s = [...values].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0; };
const time = frame => +(frame / FPS).toFixed(2);

/** 24×16 thumbnail from a W×H frame, by 4×4 box average. */
function thumb(frame) {
  const out = new Float64Array(384);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 24; x++) {
    let s = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += frame[(y * 4 + dy) * W + x * 4 + dx];
    out[y * 24 + x] = s / 16;
  }
  return out;
}

function tile(frame, t) {
  const tx = t % 4, ty = (t - tx) / 4, out = new Float64Array(384);
  let o = 0;
  for (let y = ty * 16; y < ty * 16 + 16; y++) for (let x = tx * 24; x < tx * 24 + 24; x++) out[o++] = frame[y * W + x];
  return out;
}

/**
 * The motion checks, on W×H grey frames. `stills` (optional) are the grey
 * first and last stills, for the endpoint match and the two-picture blend.
 */
export function analyseFrames(frames, { kind = 'crossing', from = null, to = null } = {}) {
  const n = frames.length;
  const flags = [];
  const metrics = { frames: n };
  if (n < 8) {
    flags.push({ code: 'too-short', severity: 'error', message: `Only ${n} frames decoded` });
    return { flags, metrics };
  }

  // Step size between neighbouring frames.
  const step = [];
  for (let i = 1; i < n; i++) step.push(mad(frames[i - 1], frames[i]));
  const median = sortedAt(step, 0.5), p90 = sortedAt(step, 0.9);
  Object.assign(metrics, { medianStep: +median.toFixed(2), p90Step: +p90.toFixed(2), maxStep: +Math.max(...step).toFixed(2) });

  // Hard cut: one jump far above the clip's own motion and above its neighbourhood
  // (fast motion elsewhere — a bird's wings — raises the clip-wide level).
  const localMedian = i => sortedAt([...step.slice(Math.max(0, i - 6), i), ...step.slice(i + 1, i + 7)], 0.5) || median;
  for (let i = 0; i < step.length; i++) {
    const d = step[i], local = localMedian(i);
    if (d > 12 && (d > Math.max(6 * median, 3 * p90) || d > 4 * Math.max(local, 1))) {
      flags.push({ code: 'hard-cut', severity: 'warn', frame: i + 1, at: time(i + 1),
        message: `A jump between frames ${i} and ${i + 1} (${d.toFixed(1)} vs ${local.toFixed(1)} around it): a cut or a punch-in` });
    }
  }

  // Structure break: consecutive thumbnails stop correlating (a cut hidden under
  // fast motion). Dark or textureless frames trip it too — look.
  const thumbs = frames.map(thumb);
  const breaks = [];
  for (let i = 1; i < n; i++) {
    const c = correlation(thumbs[i - 1], thumbs[i]);
    if (c < 0.6) breaks.push({ frame: i, c });
  }
  for (const b of breaks.slice(0, 6)) {
    flags.push({ code: 'structure-break', severity: 'warn', frame: b.frame, at: time(b.frame),
      message: `The picture changes structure at frame ${b.frame} (correlation ${b.c.toFixed(2)}): a cut, a punch-in, or dark frames` });
  }
  if (breaks.length > 6) flags.push({ code: 'structure-break', severity: 'warn', message: `${breaks.length - 6} more structure breaks` });

  // Dissolve, whole frame: over 24 frames the picture tracks the straight line
  // between the window's ends — a blend, not a move.
  const dissolves = [];
  for (let a = 0; a + 24 < n; a += 6) {
    const A = frames[a], B = frames[a + 24];
    const ends = mad(A, B);
    if (ends < 8) continue;
    let residual = 0, count = 0;
    for (let k = 4; k < 20; k += 4) {
      const f = frames[a + k], t = k / 24;
      let s = 0;
      for (let i = 0; i < PIXELS; i++) s += Math.abs(f[i] - ((1 - t) * A[i] + t * B[i]));
      residual += s / PIXELS; count++;
    }
    residual /= count;
    if (residual < 0.18 * ends && residual < 4) dissolves.push({ from: a, to: a + 24 });
  }
  // Crossfade by region: each of 16 tiles fitted as a blend of the window's end
  // frames; flag when 6+ changing tiles blend (a white-out into cloud also reads so).
  const blends = [];
  const tiles = frames.map(frame => Array.from({ length: 16 }, (_, t) => tile(frame, t)));
  for (const span of [16, 24, 36]) {
    for (let a = 0; a + span < n; a += 4) {
      let blended = 0, changing = 0;
      for (let t = 0; t < 16; t++) {
        const A = tiles[a][t], B = tiles[a + span][t];
        let ends = 0;
        for (let q = 0; q < 384; q++) ends += Math.abs(B[q] - A[q]);
        ends /= 384;
        if (ends <= 25) continue;
        changing++;
        let res = 0, c = 0;
        for (let k = 2; k < span - 1; k += 2) {
          const X = tiles[a + k][t];
          let num = 0, den = 0;
          for (let q = 0; q < 384; q++) { const d = B[q] - A[q]; num += (X[q] - A[q]) * d; den += d * d; }
          const alpha = Math.min(1, Math.max(0, num / (den + 1e-6)));
          let r = 0;
          for (let q = 0; q < 384; q++) r += Math.abs(X[q] - A[q] - alpha * (B[q] - A[q]));
          res += r / 384; c++;
        }
        if (res / c / ends < 0.07) blended++;
      }
      if (changing >= 3 && blended >= 6) blends.push({ from: a, to: a + span });
    }
  }
  // Two-picture blend (crossings): middle frames that are a mix of the first and
  // last stills, the mix sliding from one to the other.
  const stillBlend = [];
  if (kind === 'crossing' && from && to && mad(from, to) > 12) {
    let run = [];
    for (let i = Math.floor(n * 0.1); i < Math.ceil(n * 0.9); i++) {
      const f = frames[i];
      let num = 0, den = 0;
      for (let q = 0; q < PIXELS; q++) { const d = to[q] - from[q]; num += (f[q] - from[q]) * d; den += d * d; }
      const alpha = num / (den + 1e-6);
      let r = 0;
      for (let q = 0; q < PIXELS; q++) r += Math.abs(f[q] - from[q] - alpha * (to[q] - from[q]));
      r /= PIXELS;
      const blend = alpha > 0.15 && alpha < 0.85 && r < 0.25 * mad(from, to) && r < 6;
      if (blend) run.push(i);
      else { if (run.length >= 6) stillBlend.push([run[0], run.at(-1)]); run = []; }
    }
    if (run.length >= 6) stillBlend.push([run[0], run.at(-1)]);
  }
  const merged = mergeRanges([...dissolves.map(d => [d.from, d.to]), ...blends.map(b => [b.from, b.to]), ...stillBlend]);
  for (const [a, b] of merged) {
    flags.push({ code: 'dissolve', severity: 'warn', frame: Math.round((a + b) / 2), at: time(Math.round((a + b) / 2)),
      message: `Frames ${a}–${b} (${time(a)}–${time(b)} s) look like one picture blending into another: a dissolve or crossfade — or a white-out into cloud or spray. Look at them.` });
  }

  // Frozen tail: the last frames stop moving.
  let still = 0;
  for (let i = step.length - 1; i >= 0 && step[i] < 0.6; i--) still++;
  metrics.stillTailSeconds = time(still);
  if (kind === 'loop') {
    // A living photograph holds its camera still on purpose, so a still tail is
    // not a stall. What matters is whether the picture moves at all: loops were
    // rejected as "way too subtle" when only one small thing moved.
    if (still >= step.length - 1) {
      flags.push({ code: 'barely-moves', severity: 'warn', frame: 0, at: 0,
        message: 'Almost nothing moves at screening size. Subtle motion (cloud, water, breath) can still be there: watch it at full size and check the whole picture feels alive.' });
    }
  } else if (still >= Math.round(1.5 * FPS)) {
    flags.push({ code: 'frozen-tail', severity: 'warn', frame: n - still, at: time(n - still),
      message: `The last ${time(still)} s barely move: the film stalls before it lands` });
  }

  // Brightness flash at a loop's seam: a jump in overall brightness in the
  // first or last half second that the rest of the clip does not have.
  const lum = frames.map(mean);
  const dl = lum.slice(1).map((v, i) => Math.abs(v - lum[i]));
  const typical = sortedAt(dl, 0.5);
  const edge = Math.min(12, Math.floor(dl.length / 4));
  const seam = [...dl.slice(0, edge).map((d, i) => [d, i + 1]), ...dl.slice(-edge).map((d, i) => [d, dl.length - edge + i + 1])];
  const [worst, at] = seam.reduce((best, x) => (x[0] > best[0] ? x : best), [0, 0]);
  metrics.seamBrightnessJump = +worst.toFixed(2);
  if (kind !== 'crossing' && worst > Math.max(3, 5 * typical)) {
    flags.push({ code: 'seam-flash', severity: 'warn', frame: at, at: time(at),
      message: `Brightness jumps by ${worst.toFixed(1)} at frame ${at}, near the loop's seam: it will flicker every time it loops` });
  }

  // Endpoints: the film must start on its first still and land on its last.
  if (from) {
    const c = correlation(frames[0], from);
    metrics.firstFrameMatch = +c.toFixed(3);
    if (c < 0.9) flags.push({ code: 'start-mismatch', severity: c < 0.7 ? 'error' : 'warn', frame: 0, at: 0,
      message: `The first frame matches its still at ${c.toFixed(2)} (expect > 0.9)` });
  }
  if (to) {
    const c = correlation(frames[n - 1], to);
    metrics.lastFrameMatch = +c.toFixed(3);
    if (c < 0.9) flags.push({ code: 'end-mismatch', severity: c < 0.7 ? 'error' : 'warn', frame: n - 1, at: time(n - 1),
      message: `The last frame matches its still at ${c.toFixed(2)} (expect > 0.9)` });
  }
  return { flags, metrics };
}

function mergeRanges(ranges) {
  const sorted = ranges.map(r => [...r]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range[0] <= last[1] + 2) last[1] = Math.max(last[1], range[1]);
    else out.push(range);
  }
  return out;
}

/** Below this a take's sound is nearly inaudible even after build levels it: worth a listen. */
export const QUIET_LUFS = -40;

/** Integrated loudness (LUFS) and true peak (dBFS) of a file's audio. */
export async function loudness(path) {
  // ffmpeg prints the ebur128 summary on stderr.
  const log = await stderrOf(FFMPEG, ['-hide_banner', '-nostats', '-nostdin', '-i', path, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const lufs = [...log.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].pop()?.[1];
  const peak = [...log.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)].pop()?.[1];
  const num = v => (v === undefined ? null : v === '-inf' ? -Infinity : Number(v));
  return { lufs: num(lufs), truePeak: num(peak) };
}

/** Run a tool and return what it wrote to stderr (where ffmpeg reports measurements). */
export function stderrOf(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-64000); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(err) : reject(new Error(`${command} failed (${code}): ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

/** A 4×2 contact sheet of 8 frames with their times, for looking at a take quickly. */
export async function contactSheet(video, out, { frames, tileWidth = 480 } = {}) {
  const info = await probe(video);
  const count = frames ?? info.frames;
  const picks = Array.from({ length: 8 }, (_, i) => Math.min(count - 1, Math.round(i * (count - 1) / 7)));
  const tileHeight = Math.round(tileWidth * info.height / Math.max(1, info.width) / 2) * 2;
  const images = await Promise.all(picks.map(frame => frameImage(video, frame, tileWidth, tileHeight)));
  const label = (text) => Buffer.from(`<svg width="${tileWidth}" height="28" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="black" fill-opacity="0.6"/><text x="8" y="20" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="white">${text}</text></svg>`);
  const composite = [];
  images.forEach((image, i) => {
    const left = (i % 4) * tileWidth, top = Math.floor(i / 4) * tileHeight;
    composite.push({ input: image, left, top });
    composite.push({ input: label(`${time(picks[i]).toFixed(2)} s · frame ${picks[i]}`), left, top });
  });
  try {
    await sharp({ create: { width: tileWidth * 4, height: tileHeight * 2, channels: 3, background: '#000' } }).composite(composite).jpeg({ quality: 85 }).toFile(out);
  } catch {
    // Text needs a font; without one, the sheet still shows the frames.
    await sharp({ create: { width: tileWidth * 4, height: tileHeight * 2, channels: 3, background: '#000' } })
      .composite(composite.filter((_, i) => i % 2 === 0)).jpeg({ quality: 85 }).toFile(out);
  }
  return picks;
}

/** One frame of a video as an encoded image (JPEG), optionally resized. */
export async function frameImage(video, frame, width, height) {
  const scale = width ? `,scale=${width}:${height}:flags=lanczos` : '';
  const bytes = await run(FFMPEG, ['-v', 'error', '-nostdin', '-i', video, '-vf', `select=eq(n\\,${frame})${scale}`, '-vsync', 'vfr', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', '-']);
  return bytes;
}

/**
 * Screen one take. `journal` is its render receipt; `fromStill`/`toStill` are
 * the canonical stills it must start and end on.
 */
export async function screenTake({ video, journal, fromStill, toStill, sheetPath, framesDir }) {
  const flags = [];
  const info = await probe(video);
  const expected = journal.width && journal.height ? { width: journal.width * 2, height: journal.height * 2 } : null;
  if (expected && (info.width !== expected.width || info.height !== expected.height)) {
    flags.push({ code: 'size', severity: 'error', message: `The film is ${info.width}×${info.height}; a two-stage render of a ${journal.width}×${journal.height} canvas arrives as ${expected.width}×${expected.height}` });
  }
  if (journal.frames && Math.abs(info.frames - journal.frames) > 1) {
    flags.push({ code: 'frames', severity: 'error', message: `${info.frames} frames; ${journal.frames} were asked for` });
  }
  if (Math.abs(info.fps - FPS) > 0.05) flags.push({ code: 'fps', severity: 'error', message: `${info.fps.toFixed(2)} fps; H3 renders at 24` });
  if (!info.audioChannels) flags.push({ code: 'no-audio', severity: 'error', message: 'The film has no sound track' });

  const frames = await greyFrames(video);
  const from = fromStill ? await greyStill(fromStill) : null;
  const to = toStill ? await greyStill(toStill) : null;
  const motion = analyseFrames(frames, { kind: journal.kind, from, to });
  flags.push(...motion.flags);

  const audio = info.audioChannels ? await loudness(video) : { lufs: null, truePeak: null };
  if (info.audioChannels && (audio.lufs === null || audio.lufs < -50)) {
    flags.push({ code: 'silent', severity: 'error', message: `The sound track is silent (${audio.lufs} LUFS)` });
  } else if (audio.lufs !== null && audio.lufs < QUIET_LUFS) {
    flags.push({ code: 'quiet', severity: 'warn', message: `Very quiet (${audio.lufs} LUFS; a world's films sit near −14 after build): listen for whether the sound is really there, or the direction's sound needs more to happen` });
  } else if (audio.lufs !== null && audio.lufs > -9) {
    flags.push({ code: 'loud', severity: 'warn', message: `Very loud (${audio.lufs} LUFS); build levels it, but listen for distortion` });
  }
  if (audio.truePeak !== null && audio.truePeak > -0.1) flags.push({ code: 'clipping', severity: 'warn', message: `True peak ${audio.truePeak} dBFS: listen for clipping` });

  let sheet = null;
  if (sheetPath) { await contactSheet(video, sheetPath, { frames: info.frames }); sheet = sheetPath; }
  // Full-size frames at every flagged moment, so they can be looked at natively.
  const flaggedFrames = [];
  if (framesDir) {
    const wanted = [...new Set(flags.filter(f => Number.isInteger(f.frame)).map(f => f.frame))].slice(0, 12);
    if (wanted.length) mkdirSync(framesDir, { recursive: true });
    for (const frame of wanted) {
      const path = join(framesDir, `frame-${String(frame).padStart(4, '0')}.jpg`);
      await sharp(await frameImage(video, frame)).jpeg({ quality: 92 }).toFile(path);
      flaggedFrames.push(path);
    }
  }
  return { probe: info, flags, metrics: { ...motion.metrics, loudness: audio }, sheet, flaggedFrames };
}
