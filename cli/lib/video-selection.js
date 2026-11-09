// SAM 3 video selections belong to one exact loop and prompt. Each attempt has
// its own media; the small current receipt can change without replacing a take.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { maskOutline } from './outline.js';
import { sha256, sha256File } from './files.js';
import { FFMPEG, probeTrackingVideo } from './media.js';
import { samPrompt } from '../commands/select.js';

export const SAM_VIDEO_MODEL = 'sam3_video_segment_fp16';
export const MAX_TRACK_FRAMES = 900;

export function videoSelectionPrompt(select, frameIndex = 0, objectIndex = 0) {
  if (!select || typeof select !== 'object' || Array.isArray(select)) throw new Error('Use a select object for video tracking');
  const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;
  const positive = select.positive ?? [], negative = select.negative ?? [];
  if (!Array.isArray(positive) || !Array.isArray(negative) || positive.length + negative.length > 32 ||
      [...positive, ...negative].some(p => !Array.isArray(p) || p.length !== 2 || !p.every(unit))) throw new Error('Use at most 32 finite selection points between 0 and 1');
  if (select.text !== undefined && (typeof select.text !== 'string' || !select.text.trim() || select.text.trim().length > 240)) throw new Error('Use selection text of 1 to 240 characters');
  if (select.box !== undefined && (!Array.isArray(select.box) || select.box.length !== 4 || !select.box.every(unit) ||
      select.box[0] >= select.box[2] || select.box[1] >= select.box[3])) throw new Error('Use an ordered selection box between 0 and 1');
  if (!positive.length && !select.text && !select.box) throw new Error('Choose the object with a positive point, text or box');
  if (select.threshold !== undefined && !unit(select.threshold)) throw new Error('Use a finite selection threshold between 0 and 1');
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= MAX_TRACK_FRAMES) throw new Error('Use a zero-based source frame below 900');
  if (!Number.isSafeInteger(objectIndex) || objectIndex < 0 || objectIndex > 31) throw new Error('Use an object index from 0 to 31');
  const { maxInstances, applyMask, ...prompt } = samPrompt(select);
  if (!prompt.text && objectIndex !== 0) throw new Error('Point and single-box selections require object index 0');
  return { ...prompt, frameIndex, objectIndex, output: 'mask', edges: 'hard' };
}

export const videoSelectionHash = (sourceSha256, prompt, cleanup) =>
  sha256(JSON.stringify({ sourceSha256, prompt, cleanup: cleanup ?? null }));

/** The unknown submit is never bypassed, including by an explicit --redo. */
export function videoSelectionAction(previous, inputsHash, { redo = false } = {}) {
  if (previous?.status === 'submitting' && !previous.projectId) return 'unknown';
  if (previous?.status === 'submitted' && previous.projectId) return 'resume';
  // An expired project has nothing left to collect: only a changed selection or --redo asks again.
  if (previous?.status === 'failed' && previous.expiredAt) return previous.inputsHash !== inputsHash || redo ? 'track' : 'failed';
  if (previous?.status === 'failed' && previous.projectStatus === 'completed' && previous.projectId && previous.inputsHash === inputsHash && !redo) return 'resume';
  if (!previous || previous.inputsHash !== inputsHash || redo) return 'track';
  return previous.status === 'completed' ? 'skip' : 'failed';
}

/** Reject an input symlink that would upload a file outside this world. */
export function trackingSourceFile(paths, file) {
  const root = realpathSync(paths.dir), actual = realpathSync(file);
  const rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('The loop must be a file inside this world');
  return actual;
}

export function trackingSource(info) {
  if (!Number.isSafeInteger(info.width) || info.width <= 0 || !Number.isSafeInteger(info.height) || info.height <= 0 ||
      !Number.isSafeInteger(info.frames) || info.frames <= 0 || info.frames > MAX_TRACK_FRAMES ||
      !Number.isFinite(info.fps) || info.fps <= 0 || info.frames / info.fps > 30 + 1e-6) {
    throw new Error('Video tracking needs a complete source of at most 30 seconds and 900 frames');
  }
  return { width: info.width, height: info.height, frames: info.frames, fps: info.fps };
}

/** Verify the delivered artifact against the worker's stored selection receipt. */
export function validateTrackingReceipt(job, bytes, sourceSha256, source) {
  // Live SDK Job objects expose provenance; projects.get returns RawJob.result.
  const receipt = job?.provenance ?? job?.result ?? job;
  if (!receipt || receipt.sourceVideoSha256 !== sourceSha256 || receipt.sha256 !== sha256(bytes) ||
      receipt.maskWidth !== source.width || receipt.maskHeight !== source.height || receipt.maskFrames !== source.frames ||
      !Number.isFinite(receipt.maskFps) || Math.abs(receipt.maskFps - source.fps) > 0.001) {
    throw new Error('The video mask receipt does not match the uploaded loop, downloaded bytes and source timing');
  }
  return receipt;
}

/**
 * Decode one mask frame at a time. Backpressure bounds memory to a frame plus a
 * pipe chunk; the original resolution and every source frame are preserved.
 */
export async function maskVideoOutlines(file, source, cleanup = {}, { probeVideo = probeTrackingVideo } = {}) {
  const info = trackingSource(await probeVideo(file));
  if (info.width !== source.width || info.height !== source.height || info.frames !== source.frames || Math.abs(info.fps - source.fps) > 0.001) {
    throw new Error('The downloaded mask does not have the source geometry and timing');
  }
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-vsync', '0', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', pending = Buffer.alloc(0);
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Mask decoding failed: ' + stderr)));
  });
  // Attach immediately: a decode failure may occur while the stream is read.
  ended.catch(() => {});
  const frames = [], frameBytes = source.width * source.height;
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        if (frames.length >= source.frames) throw new Error('Mask decoding returned too many frames');
        const pixels = Uint8Array.from(pending.subarray(0, frameBytes), x => x >= 128 ? 1 : 0);
        const outline = maskOutline({ pixels, width: source.width, height: source.height }, { keepRatio: 0, holeRatio: 0, minArea: 0, ...cleanup });
        frames.push(outline.path);
        pending = pending.subarray(frameBytes);
      }
    }
    await ended;
    if (pending.length || frames.length !== source.frames) throw new Error('Mask decoding did not return every complete source frame');
  } catch (error) {
    child.kill('SIGTERM');
    await ended.catch(() => {});
    throw error;
  }
  return { width: source.width, height: source.height, fps: source.fps, frames };
}

export function trackingAttempt(paths, key) {
  const attempt = randomUUID();
  const base = key + '-' + attempt;
  return { attempt, mask: join(paths.selections, 'video', base + '.mask.mp4'), outlines: join(paths.selections, 'video', base + '.outlines.json') };
}

/** The traced outlines a build uses are present and unchanged (the mask may still be missing). */
export function outlinesIntact(paths, receipt) {
  if (!/^[a-z0-9_-]+\.outlines\.json$/.test(receipt.outlines ?? '') || typeof receipt.outlinesSha256 !== 'string') return false;
  const outlines = join(paths.selections, 'video', receipt.outlines);
  return existsSync(outlines) && sha256File(outlines) === receipt.outlinesSha256;
}

/** Lost local output is collected from its existing paid project, not regenerated. */
export function trackingArtifactsAvailable(paths, receipt) {
  if (!/^[a-z0-9_-]+\.mask\.mp4$/.test(receipt.mask ?? '') || !/^[a-z0-9_-]+\.outlines\.json$/.test(receipt.outlines ?? '')) return false;
  const mask = join(paths.selections, 'video', receipt.mask), outlines = join(paths.selections, 'video', receipt.outlines);
  return existsSync(mask) && existsSync(outlines) && sha256File(mask) === receipt.maskSha256 && sha256File(outlines) === receipt.outlinesSha256;
}

/** A build uses tracking only while its exact approved loop and clicks match. */
export function usableTracking(paths, key, sourceSha256, select) {
  const file = join(paths.selections, key + '.video.json');
  if (!existsSync(file)) return null;
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  if (receipt.status !== 'completed' || receipt.sourceSha256 !== sourceSha256) return null;
  const source = trackingSource(receipt.source ?? {});
  const prompt = videoSelectionPrompt(select, receipt.prompt?.frameIndex, receipt.prompt?.objectIndex);
  if (receipt.inputsHash !== videoSelectionHash(sourceSha256, prompt, select.cleanup)) return null;
  if (typeof receipt.outlines !== 'string' || !/^[a-z0-9_-]+-[a-f0-9-]+\.outlines\.json$/.test(receipt.outlines)) throw new Error('Invalid video outline receipt');
  const path = trackingSourceFile(paths, join(paths.selections, 'video', receipt.outlines));
  if (sha256File(path) !== receipt.outlinesSha256) throw new Error('Video outlines changed after tracking; run world track again');
  const track = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(track.frames) || track.frames.length !== source.frames || track.width !== source.width ||
      track.height !== source.height || !Number.isFinite(track.fps) || Math.abs(track.fps - source.fps) > 0.001 || track.frames.some(x => typeof x !== 'string')) {
    throw new Error('Video outlines do not match their tracking receipt');
  }
  return track;
}
