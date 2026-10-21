// Automatic checks on a finished take, for the defects that get a film rejected
// on sight: a dissolve or crossfade between two pictures, a hard cut, a
// structure break (a fast camera move is only a note), a film that does not
// start or land on its stills, a frozen tail, a flash at a loop's seam,
// silence. The numbers are a screen, not a verdict — they say where to look.
// The detectors are the ones that screened The Long White Cloud's 57 films;
// each flag names the frame to inspect.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FFMPEG, run, probe } from './media.js';
import { FPS, ON_ONE_STILL } from './h3.js';

export const W = 96;
/** Below this whole-film reach (mean grey change from the first frame, 0–255) a loop barely moves. */
export const LOOP_REACH = 3.5;
/** Below this, little happens in a moment. */
export const MOMENT_REACH = 5;
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

/**
 * A picture's layout, whatever its lighting: edge strength (gradient
 * magnitude) of the picture squashed to 192×128 with its levels stretched.
 * Two photographs of one room by day and by night share it; two places do not.
 */
export async function layoutOf(path, width = 192, height = 128) {
  const grey = await sharp(path).resize(width, height, { fit: 'fill' }).greyscale().normalise().raw().toBuffer();
  const edges = new Float64Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    edges[i] = Math.hypot(grey[i + 1] - grey[i - 1], grey[i + width] - grey[i - width]);
  }
  return edges;
}

/**
 * Above this, two stills are one viewpoint (the same room at another hour, or
 * with other furniture). Measured on two one-shot worlds: such pairs scored
 * 0.60–0.73, every crossing between real places 0.11 or less.
 */
export const SAME_VIEW = 0.4;

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
const spread = a => { const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / a.length); };
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

  // Structure break: a frame's thumbnail stops correlating with the one before
  // while the frames around it flow (a cut hidden under motion), or drops far
  // below its neighbours. A fast pan or fly-through keeps the correlation low for
  // many frames in a row and changes smoothly: that is movement, so it is only
  // a note. Textureless thumbnails (sky, fog, black) have no structure to
  // compare; a sudden blank frame is a jump the hard-cut check sees.
  const thumbs = frames.map(thumb);
  const flow = [null];
  for (let i = 1; i < n; i++) flow.push(spread(thumbs[i - 1]) >= 4 && spread(thumbs[i]) >= 4 ? correlation(thumbs[i - 1], thumbs[i]) : null);
  const side = (a, b) => {
    const near = flow.slice(Math.max(1, a), Math.max(1, b)).filter(c => c !== null);
    return near.length ? [sortedAt(near, 0.5)] : [];
  };
  const breaks = [], fast = [];
  for (let i = 1; i < n; i++) {
    const c = flow[i];
    if (c === null || c >= 0.6) continue;
    const around = [...side(i - 3, i), ...side(i + 1, i + 4)];
    if (!around.length) continue;
    if (Math.min(...around) >= 0.75 || (c < 0.2 && c < Math.max(...around) - 0.4)) breaks.push({ frame: i, c });
    else fast.push(i);
  }
  for (const b of breaks.slice(0, 6)) {
    flags.push({ code: 'structure-break', severity: 'warn', frame: b.frame, at: time(b.frame),
      message: `The picture changes structure at frame ${b.frame} (correlation ${b.c.toFixed(2)}) while the frames around it flow: a cut or a punch-in` });
  }
  if (breaks.length > 6) flags.push({ code: 'structure-break', severity: 'warn', message: `${breaks.length - 6} more structure breaks` });
  // One note per stretch: moments of fast movement less than a second apart are one move.
  for (const [a, b] of mergeRanges(fast.map(i => [i, i + FPS]))) {
    const end = b - FPS;
    flags.push({ code: 'fast-motion', severity: 'note', frame: Math.round((a + end) / 2), at: time(Math.round((a + end) / 2)),
      message: `Fast movement from ${time(a)} s to ${time(end)} s: the picture changes a lot from frame to frame, but smoothly — a fast camera move, not a cut. Watch it at full size for smearing or a hidden cut.` });
  }

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
  // Two-picture blend (crossings, and a reveal and the film back from it): middle frames that are a mix of the first and
  // last stills, the mix sliding from one to the other.
  const stillBlend = [];
  if (!ON_ONE_STILL.has(kind) && from && to && mad(from, to) > 12) {
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
  // How far the picture ever gets from its first frame, over the whole film. A
  // single nudge (the landing on a pinned last frame, a jump at frame 1) resets
  // a count of still frames, but not this. Measured on two one-shot worlds:
  // loops judged dead stayed under 3, living ones reached 8 to 31; moments in
  // which a device only lit up stayed under 4.3, moments where something
  // happened reached 8 or more (a thin shower of rain reached only 3.1, so this
  // says where to look, never what to decide).
  const reach = frames.reduce((most, frame) => Math.max(most, mad(frame, frames[0])), 0);
  metrics.reach = +reach.toFixed(2);
  let littleHappens = false;
  if (kind === 'loop') {
    // A living photograph holds its camera still on purpose, so a still tail is
    // not a stall. What matters is whether the picture moves at all: loops were
    // rejected as "way too subtle" when only one small thing moved.
    if (still >= step.length - 1 || reach < LOOP_REACH) {
      flags.push({ code: 'barely-moves', severity: 'warn', frame: 0, at: 0,
        message: 'Almost nothing moves at screening size. Subtle motion (cloud, water, breath) can still be there: watch it at full size and check the whole picture feels alive.' });
    }
  } else if (kind === 'moment' && reach < MOMENT_REACH) {
    littleHappens = true;
    flags.push({ code: 'little-happens', severity: 'warn', frame: Math.round(n / 2), at: time(Math.round(n / 2)),
      message: `Across the whole film the picture stays close to its first frame (reach ${reach.toFixed(1)}): look at it at full size and ask what the visitor sees happen. A light, a screen or a glow coming on and going off again is not a payoff; a moment shows something take place (docs/directing-films.md › Every click pays off)` });
  }
  if (kind !== 'loop' && !littleHappens && still >= Math.round(1.5 * FPS)) {
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
  if (ON_ONE_STILL.has(kind) && worst > Math.max(3, 5 * typical)) {
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

/**
 * How far a film that starts and ends on one still may zoom (a fraction of its
 * size) and slide (a fraction of the frame), for longer than a moment, by the
 * camera its plan chose. A zoom is never right there: whatever pushes in has
 * to pull back out to land, and that yo-yo is what gets such a film rejected.
 * Measured on real takes: the push-ins people rejected held 8–26% for 2 s or
 * more; 22 approved loops never held more than 3% past a single sample.
 */
export const CAMERA_LIMITS = Object.freeze({ locked: { zoom: 0.04, shift: 0.03 }, handheld: { zoom: 0.04, shift: 0.06 }, sway: { zoom: 0.04, shift: 0.08 } });
/** Frames between camera samples, and how many samples in a row make a move rather than a wobble (1 s). */
const CAMERA_STEP = 6, CAMERA_HOLD = 4;

const edgesOf = (frame, width, height) => {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    out[i] = Math.hypot(frame[i + 1] - frame[i - 1], frame[i + width] - frame[i - width]);
  }
  return out;
};

/** Correlation of `b` with `a` zoomed by `s` about the centre and slid by (dx, dy) pixels, over the middle of the frame. */
function warpedCorrelation(a, b, width, height, s, dx, dy) {
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const x0 = Math.floor(width * 0.15), x1 = Math.ceil(width * 0.85), y0 = Math.floor(height * 0.15), y1 = Math.ceil(height * 0.85);
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) {
    const sy = (y - cy - dy) / s + cy, iy = Math.floor(sy), fy = sy - iy;
    if (iy < 0 || iy >= height - 1) continue;
    for (let x = x0; x < x1; x++) {
      const sx = (x - cx - dx) / s + cx, ix = Math.floor(sx), fx = sx - ix;
      if (ix < 0 || ix >= width - 1) continue;
      const i = iy * width + ix;
      const p = (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + width] * (1 - fx) + a[i + width + 1] * fx) * fy;
      const q = b[y * width + x];
      n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
    }
  }
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1;
}

function bestWarp(a, b, width, height, scales, xs, ys) {
  let best = { r: -2, s: 1, dx: 0, dy: 0 };
  for (const s of scales) for (const dx of xs) for (const dy of ys) {
    const r = warpedCorrelation(a, b, width, height, s, dx, dy);
    if (r > best.r) best = { r, s, dx, dy };
  }
  return best;
}
const steps = (from, to, by) => Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => +(from + i * by).toFixed(4));

/**
 * Where the camera is through the film: every quarter second, the zoom and
 * slide that best map the first frame's edges onto that frame's (edges, so a
 * lamp coming up or fog rolling in does not read as a move). Coarse on the
 * small frames, refined on the large ones. `small` is W×H, `large` 2W×2H.
 */
export function cameraPath(small, large) {
  const [w, h] = [W, H], [W2, H2] = [W * 2, H * 2];
  const s0 = edgesOf(small[0], w, h), l0 = edgesOf(large[0], W2, H2);
  const path = [];
  for (let t = CAMERA_STEP; t < Math.min(small.length, large.length) - 2; t += CAMERA_STEP) {
    const coarse = bestWarp(s0, edgesOf(small[t], w, h), w, h, steps(0.84, 1.24, 0.02), steps(-6, 6, 1), steps(-6, 6, 1));
    const fine = bestWarp(l0, edgesOf(large[t], W2, H2), W2, H2, steps(coarse.s - 0.02, coarse.s + 0.02, 0.005),
      steps(2 * coarse.dx - 2, 2 * coarse.dx + 2, 1), steps(2 * coarse.dy - 2, 2 * coarse.dy + 2, 1));
    path.push({ frame: t, zoom: +(fine.s - 1).toFixed(3), shift: +Math.hypot(fine.dx / W2, fine.dy / H2).toFixed(3) });
  }
  return path;
}

/**
 * A loop or a moment whose camera moves when its plan chose a locked one (or
 * pushes in at all): a move must last a second to count, so a wobble at one
 * sample is not one. Returns flags and the largest zoom and slide held.
 */
export function cameraMoves(path, camera = 'locked') {
  const limit = CAMERA_LIMITS[camera] ?? CAMERA_LIMITS.locked;
  // The longest run of samples in a row that pass the test.
  const held = test => {
    let longest = [], current = [];
    for (const sample of path) {
      current = test(sample) ? [...current, sample] : [];
      if (current.length > longest.length) longest = current;
    }
    return longest;
  };
  const zoomRun = held(p => Math.abs(p.zoom) >= limit.zoom);
  const shiftRun = held(p => p.shift >= limit.shift);
  const metrics = { cameraZoom: Math.max(0, ...path.map(p => Math.abs(p.zoom))), cameraShift: Math.max(0, ...path.map(p => p.shift)) };
  const flags = [];
  if (zoomRun.length >= CAMERA_HOLD) {
    const peak = zoomRun.reduce((a, b) => (Math.abs(b.zoom) > Math.abs(a.zoom) ? b : a));
    const word = peak.zoom > 0 ? 'pushes in' : 'pulls back';
    flags.push({ code: 'camera-moves', severity: 'warn', frame: peak.frame, at: time(peak.frame),
      message: `The camera ${word} ${Math.round(Math.abs(peak.zoom) * 100)}% from ${time(zoomRun[0].frame)} s to ${time(zoomRun.at(-1).frame)} s, then has to return to land on the same still: the dolly yo-yo that gets a ${camera} film rejected. Reject it; a retake keeps the camera where it is (docs/directing-films.md › Loops)` });
  }
  if (shiftRun.length >= CAMERA_HOLD) {
    const peak = shiftRun.reduce((a, b) => (b.shift > a.shift ? b : a));
    flags.push({ code: 'camera-moves', severity: 'warn', frame: peak.frame, at: time(peak.frame),
      message: `The frame slides ${Math.round(peak.shift * 100)}% from ${time(shiftRun[0].frame)} s to ${time(shiftRun.at(-1).frame)} s and back, more than a ${camera} camera does: look at it, and reject it if the camera pans or drifts away and returns` });
  }
  return { flags, metrics };
}

/**
 * The stretches where the picture changes fastest (the structure of the frame
 * four frames before against four frames after), at least a second apart. A
 * dissolve, a fade or a hidden cut sits in one of these, often shorter than
 * the gap between contact-sheet frames: the screen shows them frame by frame.
 */
export function changeStretches(frames, count = 2) {
  const thumbs = frames.map(thumb);
  const score = frames.map((_, i) => (i < 4 || i + 4 >= frames.length ? -1 : 1 - correlation(thumbs[i - 4], thumbs[i + 4])));
  const picked = [];
  const order = score.map((value, frame) => ({ value, frame })).filter(x => x.value > 0.25).sort((a, b) => b.value - a.value);
  for (const candidate of order) {
    if (picked.length >= count) break;
    if (picked.every(p => Math.abs(p.frame - candidate.frame) >= FPS)) picked.push(candidate);
  }
  return picked.sort((a, b) => a.frame - b.frame).map(p => ({ frame: p.frame, at: time(p.frame), change: +p.value.toFixed(2) }));
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

/** A contact sheet with each frame's time: 8 frames, 4×2, spread over the take or the frames given (up to 16, 4×4, for a stretch shown frame by frame). */
export async function contactSheet(video, out, { frames, tileWidth = 480, at = null } = {}) {
  const info = await probe(video);
  const count = frames ?? info.frames;
  const picks = (at ?? Array.from({ length: 8 }, (_, i) => Math.round(i * (count - 1) / 7))).slice(0, 16).map(frame => Math.min(count - 1, Math.max(0, frame)));
  const rows = Math.ceil(picks.length / 4);
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
    await sharp({ create: { width: tileWidth * 4, height: tileHeight * rows, channels: 3, background: '#000' } }).composite(composite).jpeg({ quality: 85 }).toFile(out);
  } catch {
    // Text needs a font; without one, the sheet still shows the frames.
    await sharp({ create: { width: tileWidth * 4, height: tileHeight * rows, channels: 3, background: '#000' } })
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
  // A film on one still: does its camera stay where its plan put it? (Takes from before the
  // kit recorded a camera were asked for a static one.)
  if (ON_ONE_STILL.has(journal.kind)) {
    const camera = cameraMoves(cameraPath(frames, await greyFrames(video, W * 2, H * 2)), journal.camera ?? 'locked');
    flags.push(...camera.flags);
    Object.assign(motion.metrics, camera.metrics, { camera: journal.camera ?? 'locked' });
  } else motion.metrics.changes = changeStretches(frames);

  const audio = info.audioChannels ? await loudness(video) : { lufs: null, truePeak: null };
  if (info.audioChannels && (audio.lufs === null || audio.lufs < -50)) {
    flags.push({ code: 'silent', severity: 'error', message: `The sound track is silent (${audio.lufs} LUFS)` });
  } else if (audio.lufs !== null && audio.lufs < QUIET_LUFS) {
    flags.push({ code: 'quiet', severity: 'warn', message: `Very quiet (${audio.lufs} LUFS; after build a world's films sit near −16 and its loops near −24): listen for whether the sound is really there, or the direction's sound needs more to happen` });
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
