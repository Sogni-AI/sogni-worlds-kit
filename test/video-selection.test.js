import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, FFMPEG, probeTrackingVideo } from '../cli/lib/media.js';
import { readJson, sha256 } from '../cli/lib/files.js';
import { retraceFromMask, trackObject } from '../cli/commands/track.js';
import { waitForProject } from '../cli/lib/sogni.js';
import { ApiError } from '@sogni-ai/sogni-client';
import { maskVideoOutlines, outlineBox, TRACE_VERSION, trackingSourceFile, usableTracking, validateTrackingReceipt,
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
  const session = { billing: { tokenType: 'spark', mode: 'subscription' }, appId: 'test-track', username: 'tester',
    client: { projects: { create: async p => { sent.push(p); return { id: 'ONE' }; } } } };
  const refusals = { creating: fn => fn() };
  const deps = { wait: async () => ({ id: 'ONE' }), download: async () => ({ bytes, job: { id: 'ONE-0', imgID: 'MASK', result: job } }),
    trace: async () => ({ width: 16, height: 16, fps: 2, frames: ['M1 1L3 1L3 3Z', 'M8 1L10 1L10 3Z'] }) };
  return { dir, paths, task, bytes, job, sent, session, refusals, deps };
}

/** Rewrite the pointer and every attempt record (as an older or interrupted run left them). */
function editTrackingAttempt(f, edit) {
  const pointer = join(f.paths.selections, f.task.key + '.video.json');
  for (const file of [pointer, ...readdirSync(join(f.paths.selections, 'video')).filter(n => n.endsWith('.attempt.json')).map(n => join(f.paths.selections, 'video', n))]) {
    const journal = readJson(file);
    edit(journal);
    writeFileSync(file, JSON.stringify(journal));
  }
}

/** Age an attempt's submission; it keeps the account that submitted it unless a test removes it. */
function ageTrackingAttempt(f, submittedAt) {
  editTrackingAttempt(f, journal => { journal.submittedAt = submittedAt; });
}

/** A Kit 0.4.0 receipt: start time only, no submission time or account. */
function legacyTrackingAttempt(f, startedAt) {
  editTrackingAttempt(f, journal => { journal.startedAt = startedAt; delete journal.submittedAt; delete journal.submittedBy; });
}

test('an accepted project missing from both owner lookups after 24 hours permits an explicit new attempt', async t => {
  const f = fixture(t);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps,
    wait: async () => { throw new Error('connection interrupted'); } }), /connection interrupted/);
  ageTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  const reads = [];
  Object.assign(f.session.client.projects, {
    trackedProjects: [],
    listProjectsElsewhere: async () => { reads.push('live'); return []; },
    get: async () => { reads.push('v1'); return null; },
    getStatus: async () => { reads.push('v2'); throw new ApiError(404, { status: 'error', errorCode: 404, message: 'not found' }); },
  });
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps,
    wait: (client, project, options) => waitForProject(client, project, { ...options, sleep: async () => {} }) }), /expired.*--redo/);
  const journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
  assert.equal(journal.status, 'failed');
  assert.equal(journal.submittedBy, 'tester');
  assert.ok(Date.parse(journal.expiredAt) > 0, 'expiry is its own field');
  assert.equal(journal.projectStatus, undefined, 'expiry never overwrites what was known');
  assert.equal(journal.lastError, 'connection interrupted', 'the earlier error is kept');
  assert.equal(f.sent.length, 1, 'classifying expiry never submits replacement work');
  assert.equal(reads.filter(x => x === 'v2').length, 1, 'one owner-scoped status lookup');
  await assert.rejects(trackObject(f.task, f.session, f.refusals, f.deps), /previous job failed/);
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, redo: true });
  assert.equal(f.sent.length, 2, 'a second project requires the explicit redo');
});

test('expiry recovery accepts a legacy 404 and permits changed selection only after confirming absence', async t => {
  const f = fixture(t);
  const interrupted = async () => { throw new Error('connection interrupted'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /connection interrupted/);
  ageTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  const missing = () => { throw new ApiError(404, { status: 'error', errorCode: 404, message: 'not found' }); };
  Object.assign(f.session.client.projects, { trackedProjects: [], listProjectsElsewhere: async () => [], getStatus: missing, get: missing });
  await assert.rejects(trackObject({ ...f.task, inputsHash: 'e'.repeat(64) }, f.session, f.refusals,
    { ...f.deps, wait: interrupted, redo: true }), /expired.*--redo/);
  assert.equal(f.sent.length, 1, 'neither changed clicks nor redo abandons the existing attempt during recovery');
  assert.ok(readJson(join(f.paths.selections, f.task.key + '.video.json')).expiredAt);
  await trackObject({ ...f.task, inputsHash: 'e'.repeat(64) }, f.session, f.refusals, f.deps);
  assert.equal(f.sent.length, 2);
});

test('age alone or an incomplete owner lookup never permits replay', async t => {
  const missing = async () => { throw new ApiError(404, { status: 'error', errorCode: 404, message: 'not found' }); };
  const unavailable = async () => { throw new ApiError(503, { status: 'error', errorCode: 503, message: 'unknown' }); };
  const cases = [
    { name: 'younger than 24 hours', age: new Date(Date.now() - 23 * 60 * 60_000).toISOString() },
    { name: 'unknown submission time', age: 'invalid' },
    { name: 'future timestamp', age: new Date(Date.now() + 60_000).toISOString() },
    { name: 'live in this app', projects: { trackedProjects: [{ id: 'ONE' }] } },
    { name: 'live in another app', projects: { listProjectsElsewhere: async () => [{ id: 'ONE', appId: 'earlier' }] } },
    { name: 'unknown live response', projects: { listProjectsElsewhere: async () => ({}) } },
    { name: 'live lookup unavailable', projects: { listProjectsElsewhere: unavailable } },
    { name: 'status lookup unavailable', projects: { getStatus: unavailable } },
    { name: 'status lookup forbidden', projects: { getStatus: async () => { throw new ApiError(403, { status: 'error', errorCode: 403, message: 'forbidden' }); } } },
    { name: 'legacy lookup unavailable', projects: { get: unavailable } },
    { name: 'stored result exists', projects: { get: async () => ({ id: 'ONE', status: 'completed' }) } },
    { name: 'unknown legacy response', projects: { get: async () => [] } },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const f = fixture(t);
    const interrupted = async () => { throw new Error('wait interrupted'); };
    await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
    ageTrackingAttempt(f, item.age ?? new Date(Date.now() - 25 * 60 * 60_000).toISOString());
    Object.assign(f.session.client.projects, { trackedProjects: [], listProjectsElsewhere: async () => [], getStatus: missing, get: async () => null }, item.projects);
    await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
    assert.equal(readJson(join(f.paths.selections, f.task.key + '.video.json')).status, 'submitted');
    await assert.rejects(trackObject({ ...f.task, inputsHash: 'e'.repeat(64) }, f.session, f.refusals,
      { ...f.deps, wait: interrupted, redo: true }), /wait interrupted/);
    assert.equal(f.sent.length, 1);
  });
});

test('an old start time never expires a recently accepted project', async t => {
  const f = fixture(t);
  const interrupted = async () => { throw new Error('wait interrupted'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  const pointer = join(f.paths.selections, f.task.key + '.video.json');
  editTrackingAttempt(f, journal => { journal.startedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString(); });
  let liveReads = 0;
  Object.assign(f.session.client.projects, { trackedProjects: [], listProjectsElsewhere: async () => { liveReads += 1; return []; },
    getStatus: async () => { throw new ApiError(404, { status: 'error', errorCode: 404, message: 'not found' }); }, get: async () => null });
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  assert.equal(readJson(pointer).status, 'submitted');
  assert.equal(liveReads, 0, 'a recent acceptance never triggers expiry lookups');
});

const DAY = 24 * 60 * 60_000;
const notFound = async () => { throw new ApiError(404, { status: 'error', errorCode: 404, message: 'not found' }); };
const rateLimited = async () => { throw new ApiError(429, { status: 'error', errorCode: 429, message: 'rate limited' }); };
/** Every owner lookup says the project is gone: only the guards under test can keep it. */
const allMissing = { trackedProjects: [], listProjectsElsewhere: async () => [], getStatus: notFound, get: async () => null };

test('expiry needs over 24 hours: exactly 24 hours keeps the project, one millisecond more expires it', async t => {
  const start = Date.parse('2026-11-08T10:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = fixture(t);
  const interrupted = async () => { throw new Error('wait interrupted'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  assert.equal(readJson(join(f.paths.selections, f.task.key + '.video.json')).submittedAt, new Date(start).toISOString());
  Object.assign(f.session.client.projects, allMissing);
  t.mock.timers.setTime(start + DAY);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  assert.equal(readJson(join(f.paths.selections, f.task.key + '.video.json')).status, 'submitted');
  t.mock.timers.setTime(start + DAY + 1);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /expired/);
  assert.equal(f.sent.length, 1);
});

test('a forward clock jump, a missing time, rate limits or another account never expire a project', async t => {
  const cases = [
    { name: 'clock jumped 48 hours ahead, status lookup unavailable', jump: 2 * DAY, projects: { getStatus: async () => { throw new ApiError(503, { status: 'error', errorCode: 503, message: 'unavailable' }); } } },
    { name: 'clock jumped 48 hours ahead, project still live elsewhere', jump: 2 * DAY, projects: { listProjectsElsewhere: async () => [{ id: 'ONE' }] } },
    { name: 'both timestamps absent', edit: j => { delete j.submittedAt; delete j.startedAt; } },
    { name: 'Kit 0.4.0 receipt without an account', legacy: true },
    { name: 'receipt without an account', edit: j => { delete j.submittedBy; } },
    { name: 'submitted by another account', edit: j => { j.submittedBy = 'someone-else'; } },
    { name: 'signed in without a username', username: null },
    { name: 'status lookup rate limited', projects: { getStatus: rateLimited } },
    { name: 'live lookup rate limited', projects: { listProjectsElsewhere: rateLimited } },
    { name: 'stored record rate limited', projects: { get: rateLimited } },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const f = fixture(t);
    const interrupted = async () => { throw new Error('wait interrupted'); };
    await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    if (item.legacy) legacyTrackingAttempt(f, old);
    else if (!item.jump) ageTrackingAttempt(f, old);
    if (item.edit) editTrackingAttempt(f, item.edit);
    if (item.jump) t.mock.timers.enable({ apis: ['Date'], now: Date.now() + item.jump });
    if ('username' in item) f.session.username = item.username;
    Object.assign(f.session.client.projects, allMissing, item.projects);
    await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
    const journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
    assert.equal(journal.status, 'submitted');
    assert.equal(journal.expiredAt, undefined);
    await assert.rejects(trackObject({ ...f.task, inputsHash: 'e'.repeat(64) }, f.session, f.refusals,
      { ...f.deps, wait: interrupted, redo: true }), /wait interrupted/);
    assert.equal(f.sent.length, 1, 'neither --redo nor changed clicks replace an unexpired project');
  });
});

test('a completed receipt missing only its mask keeps its outlines in use and is never demoted', async t => {
  const f = fixture(t);
  const done = await trackObject(f.task, f.session, f.refusals, f.deps);
  unlinkSync(join(f.paths.selections, 'video', done.mask));
  ageTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  Object.assign(f.session.client.projects, allMissing);
  const gone = async () => { throw new Error('result no longer stored'); };
  // A lost mask is a warning, never a stop: the rest of a run continues.
  const returned = await trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: gone });
  assert.equal(returned.status, 'completed');
  assert.match(returned.maskFetch.error, /no longer stored/);
  const journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
  assert.equal(journal.status, 'completed');
  assert.equal(journal.outlinesSha256, done.outlinesSha256);
  assert.equal(journal.expiredAt, undefined);
  assert.match(journal.maskFetch.error, /no longer stored/);
  assert.equal(usableTracking(f.paths, f.task.key, f.task.sourceSha256, f.task.select).frames.length, 2, 'the build keeps using the outlines');
  assert.equal(f.sent.length, 1);
  // A later run that can reach the result restores the mask without a new project.
  const restored = await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.maskFetch, undefined);
  assert.equal(f.sent.length, 1);
});

test('missing outlines are traced again from the mask on disk without any request', async t => {
  const f = fixture(t);
  const done = await trackObject(f.task, f.session, f.refusals, f.deps);
  unlinkSync(join(f.paths.selections, 'video', done.outlines));
  editTrackingAttempt(f, journal => { journal.maskFetch = { failedAt: 'earlier', error: 'stale' }; });
  const offline = async () => { throw new Error('no network call is allowed here'); };
  Object.assign(f.session.client.projects, { getStatus: offline, get: offline, listProjectsElsewhere: offline });
  let traced = 0;
  const receipt = await trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: offline, download: offline,
    trace: async (...args) => { traced += 1; return f.deps.trace(...args); } });
  assert.equal(traced, 1);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.maskFetch, undefined, 'a stale failed fetch is cleared');
  assert.ok(receipt.retracedAt);
  assert.equal(usableTracking(f.paths, f.task.key, f.task.sourceSha256, f.task.select).frames.length, 2);
  assert.equal(f.sent.length, 1);
});

test('a completed receipt with nothing on disk stays complete on a temporary error and expires only when gone', async t => {
  const f = fixture(t);
  const done = await trackObject(f.task, f.session, f.refusals, f.deps);
  unlinkSync(join(f.paths.selections, 'video', done.mask));
  unlinkSync(join(f.paths.selections, 'video', done.outlines));
  Object.assign(f.session.client.projects, allMissing, { getStatus: rateLimited });
  const busy = async () => { throw new ApiError(429, { status: 'error', errorCode: 429, message: 'rate limited' }); };
  const kept = await trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: busy });
  assert.equal(kept.maskFetch.outlinesMissing, true, 'a warning, never a stop for the rest of the run');
  assert.equal(usableTracking(f.paths, f.task.key, f.task.sourceSha256, f.task.select), null, 'the build falls back to the fixed outline');
  let journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
  assert.equal(journal.status, 'completed', 'a finished project is never demoted to submitted');
  assert.equal(journal.expiredAt, undefined);
  ageTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  Object.assign(f.session.client.projects, allMissing);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: busy }), /expired.*--redo/);
  journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
  assert.equal(journal.status, 'failed');
  assert.ok(journal.expiredAt);
  assert.equal(f.sent.length, 1);
});

test('receipt artifact names are checked before re-tracing writes anything', async t => {
  const f = fixture(t);
  await trackObject(f.task, f.session, f.refusals, f.deps);
  editTrackingAttempt(f, journal => { journal.outlines = '../../escape.outlines.json'; });
  const offline = async () => { throw new Error('no network call is allowed here'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: offline, download: offline }), /Invalid tracking artifact names/);
  assert.ok(!readdirSync(f.dir).includes('escape.outlines.json'));
  assert.ok(!readdirSync(join(f.dir, '..')).includes('escape.outlines.json'));
});

test('re-tracing refuses a selections folder linked outside the world', async t => {
  const f = fixture(t);
  const done = await trackObject(f.task, f.session, f.refusals, f.deps);
  unlinkSync(join(f.paths.selections, 'video', done.outlines));
  const outside = mkdtempSync(join(tmpdir(), 'sogni-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const video = join(f.paths.selections, 'video');
  for (const name of readdirSync(video)) writeFileSync(join(outside, name), readFileSync(join(video, name)));
  rmSync(video, { recursive: true });
  symlinkSync(outside, video);
  const previous = { file: join(video, readdirSync(outside).find(n => n.endsWith('.attempt.json'))), journal: readJson(join(f.paths.selections, f.task.key + '.video.json')) };
  await assert.rejects(retraceFromMask(f.paths, f.task.key, previous, f.deps.trace), /inside this world/);
  assert.ok(!readdirSync(outside).some(n => n.endsWith('.outlines.json')), 'nothing written through the link');
});

test('a changed mask on disk is never traced: the mask is fetched again from its project instead', async t => {
  const f = fixture(t);
  const done = await trackObject(f.task, f.session, f.refusals, f.deps);
  unlinkSync(join(f.paths.selections, 'video', done.outlines));
  writeFileSync(join(f.paths.selections, 'video', done.mask), 'a different mask');
  let traced = 0, waited = 0;
  const receipt = await trackObject(f.task, f.session, f.refusals, { ...f.deps,
    wait: async (...args) => { waited += 1; return f.deps.wait(...args); }, trace: async (...args) => { traced += 1; return f.deps.trace(...args); } });
  assert.equal(waited, 1, 'collected from the existing project');
  assert.equal(traced, 1, 'traced once, from the re-fetched mask');
  assert.equal(receipt.maskSha256, sha256(f.bytes));
  assert.equal(f.sent.length, 1);
});

test('collecting an older receipt without an account records the account that collected it', async t => {
  const f = fixture(t);
  const interrupted = async () => { throw new Error('wait interrupted'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  legacyTrackingAttempt(f, new Date().toISOString());
  const receipt = await trackObject(f.task, f.session, f.refusals, f.deps);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.submittedBy, 'tester');
});

test('a receipt without an account takes the signed-in account once Sogni answers for its project', async t => {
  const f = fixture(t);
  const interrupted = async () => { throw new Error('wait interrupted'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  legacyTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  f.session.client.projects.getStatus = async () => ({ finished: false, status: 'processing' });
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
  const journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
  assert.equal(journal.status, 'submitted');
  assert.equal(journal.submittedBy, 'tester');
});

test('an unanswered lookup never assigns an account, and a null account never matches a null signed-in user', async t => {
  for (const item of [{ name: 'status lookup 404', getStatus: notFound }, { name: 'status lookup 503', getStatus: async () => { throw new ApiError(503, { status: 'error', errorCode: 503, message: 'unknown' }); } }]) {
    await t.test(item.name, async t => {
      const f = fixture(t);
      const interrupted = async () => { throw new Error('wait interrupted'); };
      await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
      editTrackingAttempt(f, journal => { journal.submittedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString(); journal.submittedBy = null; });
      f.session.username = null;
      Object.assign(f.session.client.projects, allMissing, { getStatus: item.getStatus });
      await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: interrupted }), /wait interrupted/);
      const journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
      assert.equal(journal.status, 'submitted');
      assert.equal(journal.submittedBy, null);
    });
  }
});

test('expiring a failed transfer of a completed project keeps its status and error beside the expiry', async t => {
  const f = fixture(t);
  f.session.client.projects.getStatus = async () => ({ finished: true, status: 'completed' });
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, download: async () => { throw new Error('transfer reset'); } }), /transfer reset/);
  ageTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  Object.assign(f.session.client.projects, allMissing);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: async () => { throw new Error('result no longer stored'); } }), /expired.*--redo/);
  const journal = readJson(join(f.paths.selections, f.task.key + '.video.json'));
  assert.equal(journal.status, 'failed');
  assert.equal(journal.projectStatus, 'completed');
  assert.equal(journal.lastError, 'transfer reset');
  assert.ok(Date.parse(journal.expiredAt) > 0);
  assert.match(journal.expiry.error, /no longer stored/);
  await assert.rejects(trackObject(f.task, f.session, f.refusals, f.deps), /previous job failed/);
  assert.equal(f.sent.length, 1);
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, redo: true });
  assert.equal(f.sent.length, 2, 'only an explicit redo requests another mask');
});

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
  ageTrackingAttempt(f, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  let statusReads = 0;
  f.session.client.projects.getStatus = async () => { statusReads += 1; throw new Error('must not look up an unknown submit'); };
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, redo: true }), /unknown outcome/);
  await assert.rejects(trackObject({ ...f.task, inputsHash: 'f'.repeat(64) }, f.session, f.refusals, f.deps), /unknown outcome/);
  assert.equal(f.sent.length, 1);
  assert.equal(readJson(join(f.paths.selections, f.task.key + '.video.json')).status, 'submitting');
  assert.equal(statusReads, 0);
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

// A 64x64 two-frame mask: a 24x24 figure with an enclosed 6x6 hole (a held prop), a 10x10 piece far away (a fleck
// elsewhere in the scene, 18% of the figure) and a 4x3 speck (12 px²).
async function cleanupFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sogni-mask-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const S = 64, pixels = Buffer.alloc(S * S * 2);
  const fill = (f, x0, y0, x1, y1, v = 255) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels[f * S * S + y * S + x] = v; };
  for (const f of [0, 1]) { fill(f, 8, 8, 32, 32); fill(f, 17, 17, 23, 23, 0); fill(f, 48, 48, 58, 58); fill(f, 50, 6, 54, 9); }
  const file = join(dir, 'mask.mp4');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${S}x${S}`, '-framerate', '2', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', file], { input: pixels });
  return { file, source: { width: S, height: S, frames: 2, fps: 2 } };
}
const rings = path => (path.match(/M/g) ?? []).length;

test('tracing version 1 keeps every piece and hole of the mask, as Kit 0.4.0 did', async t => {
  const { file, source } = await cleanupFixture(t);
  const track = await maskVideoOutlines(file, source);
  assert.equal(rings(track.frames[0]), 4, 'figure, its hole, the far piece and the speck');
});

test('tracing version 2 fills held props, drops specks and pieces far from the object', async t => {
  const { file, source } = await cleanupFixture(t);
  const cleaned = await maskVideoOutlines(file, source, {}, { version: 2 });
  assert.equal(rings(cleaned.frames[0]), 1, 'the 6x6 hole (7% of the figure) is filled; the far piece and the speck are gone');
  assert.equal(cleaned.frames[0], cleaned.frames[1]);
  const kept = await maskVideoOutlines(file, source, { near: false }, { version: 2 });
  assert.equal(rings(kept.frames[0]), 2, 'near: false keeps the far piece (the speck stays under 16 px²)');
  const holes = await maskVideoOutlines(file, source, { near: false, holeRatio: 0 }, { version: 2 });
  assert.equal(rings(holes.frames[0]), 3, 'a world can keep holes with select.cleanup');
  const still = await maskVideoOutlines(file, source, {}, { version: 2, near: [48 / 64, 48 / 64, 58 / 64, 58 / 64] });
  assert.equal(rings(still.frames[0]), 2, 'a piece on the approved still selection stays even far from the main piece');
  await assert.rejects(maskVideoOutlines(file, source, {}, { version: 9 }), /Unknown outline tracing version/);
});

// A 128x128 frame: a 64x64 figure, a 6x6 piece beside it (0.9% of the figure, within reach of it), and a 4x4 piece
// 5 px beyond the figure's edge (within NEAR_MARGIN, 10 px here) but large enough to pass the island rule only
// because it is 16 px² against 1.2% of 4096 = 49: so it is dropped by the island rule, not by distance.
async function islandFixture(t, extra) {
  const dir = mkdtempSync(join(tmpdir(), 'sogni-mask-island-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const S = 128, pixels = Buffer.alloc(S * S * 2);
  const fill = (f, x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels[f * S * S + y * S + x] = 255; };
  for (const f of [0, 1]) { fill(f, 16, 16, 80, 80); extra(fill, f); }
  const file = join(dir, 'mask.mp4');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${S}x${S}`, '-framerate', '2', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', file], { input: pixels });
  return { file, source: { width: S, height: S, frames: 2, fps: 2 } };
}

test('pieces under 1.2% of the main one are dropped even beside it', async t => {
  const { file, source } = await islandFixture(t, (fill, f) => fill(f, 84, 30, 90, 36));
  assert.equal(rings((await maskVideoOutlines(file, source, {}, { version: 2 })).frames[0]), 1, '36 px² is under 1.2% of 4096');
  assert.equal(rings((await maskVideoOutlines(file, source, { keepRatio: 0 }, { version: 2 })).frames[0]), 2);
});

test('a piece within reach of the main one stays; beyond reach it goes', async t => {
  // 10x10 pieces (100 px² = 2.4%): one 6 px beyond the figure's right edge (within 10 px), one 30 px beyond.
  const { file, source } = await islandFixture(t, (fill, f) => { fill(f, 86, 30, 96, 40); fill(f, 110, 60, 120, 70); });
  assert.equal(rings((await maskVideoOutlines(file, source, {}, { version: 2 })).frames[0]), 2, 'the figure and the near piece');
});

test('a still selection outline gives its normalized box', () => {
  assert.deepEqual(outlineBox({ width: 200, height: 100, path: 'M20 10L60 10L60 50L20 50Z' }), [0.1, 0.1, 0.3, 0.5]);
  for (const bad of [null, { width: 0, height: 1, path: 'M0 0L1 1L1 0Z' }, { width: 10, height: 10, path: '' }, { width: 10, height: 10, path: 'M5 5L5 5L5 5Z' }]) assert.equal(outlineBox(bad), null);
});

test('collecting an interrupted track traces with the version and still box it was submitted with', async t => {
  const f = fixture(t);
  const options = [];
  const trace = async (file, source, cleanup, o) => { options.push(o); return f.deps.trace(); };
  await assert.rejects(trackObject({ ...f.task, near: [0.2, 0.2, 0.6, 0.6] }, f.session, f.refusals, { ...f.deps, wait: async () => { throw new Error('wait interrupted'); } }), /wait interrupted/);
  const done = await trackObject(f.task, f.session, f.refusals, { ...f.deps, trace });
  assert.equal(done.traceVersion, TRACE_VERSION);
  assert.deepEqual(options[0], { version: TRACE_VERSION, near: [0.2, 0.2, 0.6, 0.6] });
  // Its outlines lost later: re-traced with the same version and box.
  unlinkSync(join(f.paths.selections, 'video', done.outlines));
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, trace });
  assert.deepEqual(options[1], { version: TRACE_VERSION, near: [0.2, 0.2, 0.6, 0.6] });
  assert.equal(f.sent.length, 1);
});

test('collecting an interrupted Kit 0.4.0 track traces it as 0.4.0 did', async t => {
  const f = fixture(t);
  const options = [];
  await assert.rejects(trackObject(f.task, f.session, f.refusals, { ...f.deps, wait: async () => { throw new Error('wait interrupted'); } }), /wait interrupted/);
  editTrackingAttempt(f, journal => { delete journal.traceVersion; delete journal.near; });
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, trace: async (file, source, cleanup, o) => { options.push(o); return f.deps.trace(); } });
  assert.deepEqual(options[0], { version: 1, near: null });
});

test('new tracking records its tracing version and still box; an older receipt is re-traced as it was made', async t => {
  const f = fixture(t);
  const versions = [];
  const trace = async (file, source, cleanup, options) => { versions.push(options); return f.deps.trace(); };
  const done = await trackObject({ ...f.task, near: [0.1, 0.1, 0.5, 0.5] }, f.session, f.refusals, { ...f.deps, trace });
  assert.equal(done.traceVersion, TRACE_VERSION);
  assert.deepEqual(done.near, [0.1, 0.1, 0.5, 0.5]);
  assert.deepEqual(versions[0], { version: TRACE_VERSION, near: [0.1, 0.1, 0.5, 0.5] });
  // A receipt from Kit 0.4.0 (no version) whose outlines went missing is traced again with version 1.
  unlinkSync(join(f.paths.selections, 'video', done.outlines));
  editTrackingAttempt(f, journal => { delete journal.traceVersion; delete journal.near; });
  await trackObject(f.task, f.session, f.refusals, { ...f.deps, trace });
  assert.deepEqual(versions[1], { version: 1, near: null });
  assert.equal(f.sent.length, 1);
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
