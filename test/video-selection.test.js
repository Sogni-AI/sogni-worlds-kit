import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, FFMPEG, probeTrackingVideo } from '../cli/lib/media.js';
import { readJson, sha256 } from '../cli/lib/files.js';
import { trackObject } from '../cli/commands/track.js';
import { maskVideoOutlines, trackingSourceFile, usableTracking, validateTrackingReceipt,
  videoSelectionAction, videoSelectionHash, videoSelectionPrompt } from '../cli/lib/video-selection.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sogni-video-selection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { dir, selections: join(dir, 'selections') };
  const sourceFile = join(dir, 'loop.mp4'), sourceBytes = Buffer.from('exact approved loop');
  writeFileSync(sourceFile, sourceBytes);
  const source = { width: 16, height: 16, frames: 2, fps: 2 };
  const select = { positive: [[0.25, 0.5]], negative: [[0.8, 0.1]] };
  const prompt = videoSelectionPrompt(select), sourceSha256 = sha256(sourceBytes);
  const task = { paths, key: 'hall-lamp', sourceFile, source, sourceSha256, select, prompt,
    inputsHash: videoSelectionHash(sourceSha256, prompt), sourceTake: { film: 'hall-loop', take: 1, sha256: sourceSha256 } };
  const bytes = Buffer.from('delivered mask'), job = { sha256: sha256(bytes), sourceVideoSha256: sourceSha256,
    maskWidth: 16, maskHeight: 16, maskFrames: 2, maskFps: 2 };
  const sent = [];
  const session = { billing: { tokenType: 'spark', mode: 'subscription' }, appId: 'test-track',
    client: { projects: { create: async p => { sent.push(p); return { id: 'ONE' }; } } } };
  const refusals = { creating: fn => fn() };
  const deps = { wait: async () => ({ id: 'ONE' }), download: async () => ({ bytes, job: { id: 'ONE-0', imgID: 'MASK', result: job } }),
    trace: async () => ({ width: 16, height: 16, fps: 2, frames: ['M1 1L3 1L3 3Z', 'M8 1L10 1L10 3Z'] }) };
  return { dir, paths, task, bytes, job, sent, session, refusals, deps };
}

test('video prompts retain clicks and choose one object without image-only controls', () => {
  const prompt = videoSelectionPrompt({ text: 'lamp', instances: 12, box: [0, 0, 1, 1] }, 12, 2);
  assert.equal(prompt.text, 'lamp');
  assert.equal(prompt.frameIndex, 12);
  assert.equal(prompt.objectIndex, 2);
  assert.equal(prompt.output, 'mask');
  assert.equal(prompt.maxInstances, undefined);
  assert.throws(() => videoSelectionPrompt({}, 900));
  assert.throws(() => videoSelectionPrompt({}, 0, 32));
});

test('an uncertain submit cannot be bypassed by --redo; submitted work resumes', () => {
  assert.equal(videoSelectionAction({ status: 'submitting' }, 'same', { redo: true }), 'unknown');
  assert.equal(videoSelectionAction({ status: 'submitted', projectId: 'ONE' }, 'changed', { redo: true }), 'resume');
});

test('a confirmed failed project permits a new attempt only after redo or changed clicks', async t => {
  const f = fixture(t);
  f.session.client.projects.getStatus = async () => ({ status: 'failed', finished: true });
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: async () => { throw new Error('project failed'); } }), /project failed/);
  assert.equal(readJson(join(f.paths.selections, f.task.key + '.video.json')).status, 'failed');
  await assert.rejects(trackObject(f.task, f.session, f.refusals, f.deps), /previous job failed/);
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, redo: true });
  assert.equal(f.sent.length, 2);
});

test('a terminal completed transfer can be collected again or explicitly redone', async t => {
  const f = fixture(t);
  f.session.client.projects.getStatus = async () => ({ status: 'completed', finished: true });
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, download: async () => { throw new Error('download failed'); } }), /download failed/);
  await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(f.sent.length, 1);
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, redo: true });
  assert.equal(f.sent.length, 2);
});

test('an unknown lookup or a still-running project cannot authorize replay', async t => {
  for (const lookup of [async () => { throw new Error('lookup unavailable'); }, async () => ({ status: 'running', finished: false })]) {
    const f = fixture(t);
    f.session.client.projects.getStatus = lookup;
    await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: async () => { throw new Error('wait expired'); } }), /wait expired/);
    await trackObject({ ...f.task, inputsHash: 'e'.repeat(64) }, f.session, f.refusals, { ...f.deps, redo: true });
    assert.equal(f.sent.length, 1);
  }
});

test('tracking receipt uses the same fractional-fps tolerance as admission', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => validateTrackingReceipt({ ...f.job, maskFps: 2.0005 }, f.bytes, f.task.sourceSha256, f.task.source));
  assert.throws(() => validateTrackingReceipt({ ...f.job, maskFps: 2.002 }, f.bytes, f.task.sourceSha256, f.task.source));
  assert.throws(() => videoSelectionPrompt(f.task.select, 0, 1), /object index 0/);
});

test('one paid job saves moving outlines, subsequent calls skip and builds bind the exact loop', async t => {
  const f = fixture(t);
  const result = await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].modelId, 'sam3_video_segment_fp16');
  assert.equal(f.sent[0].referenceVideo.type, 'video/mp4');
  assert.equal(await f.sent[0].referenceVideo.text(), 'exact approved loop');
  assert.equal(f.sent[0].disableNSFWFilter, true);
  assert.equal(result.status, 'completed');
  await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(f.sent.length, 1);
  const track = usableTracking(f.paths, f.task.key, f.task.sourceSha256, f.task.select);
  assert.equal(track.frames.length, 2);
  assert.notEqual(track.frames[0], track.frames[1]);
  assert.equal(usableTracking(f.paths, f.task.key, 'different loop', f.task.select), null);
  assert.equal(usableTracking(f.paths, f.task.key, f.task.sourceSha256, { positive: [[0.9, 0.9]] }), null);
});

test('a dropped submission stays reserved, even with --redo, and never charges twice', async t => {
  const f = fixture(t);
  f.session.client.projects.create = async () => { f.sent.push('one attempt'); throw new Error('connection closed'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, f.deps), /connection closed/);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, redo: true }), /unknown outcome/);
  await assert.rejects(trackObject({ ...f.task, inputsHash: 'f'.repeat(64) }, f.session, f.refusals, f.deps), /unknown outcome/);
  assert.equal(f.sent.length, 1);
  assert.equal(readJson(join(f.paths.selections, f.task.key + '.video.json')).status, 'submitting');
});

test('malformed coordinates fail before a paid attempt is reserved', () => {
  for (const select of [{ positive: [[NaN, 0.5]] }, { positive: [[1.1, 0.5]] }, { box: [0.5, 0, 0.1, 1] }, { text: ' ' }, { positive: [[0, 0]], threshold: Infinity }]) {
    assert.throws(() => videoSelectionPrompt(select), /selection/);
  }
});

test('an interrupted download resumes the same project and retains the original artifact', async t => {
  const f = fixture(t);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, download: async () => { throw new Error('download stalled'); } }), /download stalled/);
  await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(f.sent.length, 1);
});

test('changed clicks collect an older submitted project before any new paid work', async t => {
  const f = fixture(t);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, download: async () => { throw new Error('download stalled'); } }), /download stalled/);
  const result = await trackObject({ ...f.task, inputsHash: 'f'.repeat(64) }, f.session, f.refusals, f.deps);
  assert.equal(result.inputsHash, f.task.inputsHash, 'the original selection is collected first');
  assert.equal(f.sent.length, 1);
});

test('a missing local mask is downloaded again from the existing project without a new charge', async t => {
  const f = fixture(t);
  const receipt = await trackObject(f.task, f.session, f.refusals, f.deps);
  unlinkSync(join(f.paths.selections, 'video', receipt.mask));
  const recovered = await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(recovered.status, 'completed');
  assert.equal(f.sent.length, 1);
  assert.equal(recovered.projectId, receipt.projectId);
});

test('simultaneous requests cannot both reserve the same paid attempt', async t => {
  const f = fixture(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: async () => pending });
  await new Promise(resolve => setImmediate(resolve));
  // A second collector may resume the exact accepted project, never submit it again.
  await trackObject(f.task, f.session, f.refusals, f.deps);
  release({ id: 'ONE' });
  await first;
  assert.equal(f.sent.length, 1);
});

test('wrong source, wrong downloaded hash and timing drift fail before outline publication', t => {
  const f = fixture(t);
  for (const change of [{ sourceVideoSha256: 'other' }, { sha256: 'bad' }, { maskFrames: 3 }, { maskFps: 24 }]) {
    const invalid = { ...f.job, ...change };
    for (const job of [invalid, { result: invalid }, { provenance: invalid }]) {
      assert.throws(() => validateTrackingReceipt(job, f.bytes, f.task.sourceSha256, f.task.source), /does not match/);
    }
  }
});

test('stored RawJob.result and live SDK Job.provenance validate the same attested bytes', t => {
  const f = fixture(t);
  for (const job of [{ id: 'ONE-0', imgID: 'MASK', result: f.job }, { provenance: f.job }]) {
    assert.deepEqual(validateTrackingReceipt(job, f.bytes, f.task.sourceSha256, f.task.source), f.job);
  }
});

test('an invalid live receipt cannot fall through to a different stored receipt', t => {
  const f = fixture(t);
  assert.throws(() => validateTrackingReceipt({ provenance: { ...f.job, sha256: 'wrong' }, result: f.job },
    f.bytes, f.task.sourceSha256, f.task.source), /does not match/);
});

test('an input symlink cannot upload a file outside its world', t => {
  const f = fixture(t), outer = mkdtempSync(join(tmpdir(), 'sogni-track-outside-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const privateFile = join(outer, 'private.mp4');
  writeFileSync(privateFile, 'private');
  const link = join(f.dir, 'escape.mp4');
  symlinkSync(privateFile, link);
  assert.throws(() => trackingSourceFile(f.paths, link), /inside this world/);
});

test('the actual decoder preserves every mask frame, movement and source timing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sogni-mask-frames-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pixels = Buffer.alloc(16 * 16 * 2);
  for (let frame = 0; frame < 2; frame++) for (let y = 4; y < 10; y++) for (let x = 2 + frame * 8; x < 6 + frame * 8; x++) pixels[frame * 256 + y * 16 + x] = 255;
  const file = join(dir, 'mask.mp4');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', '16x16', '-framerate', '2', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', file], { input: pixels });
  const track = await maskVideoOutlines(file, { width: 16, height: 16, frames: 2, fps: 2 });
  const info = await probeTrackingVideo(file);
  assert.equal(info.frames, 2);
  assert.equal(info.fps, 2);
  assert.equal(track.frames.length, 2);
  assert.notEqual(track.frames[0], track.frames[1]);
  assert.equal(track.fps, 2);
});
