import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rateLimitDelay, waitForProject, RefusedError } from '../cli/lib/sogni.js';
import { waitForAudio } from '../cli/lib/audio.js';

const noSleep = async () => {};
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });
const stored = (extra = {}) => ({ id: 'p', status: 'completed', completedWorkerJobs: [{ imgID: 'r' }], ...extra });

/** A tracked SDK project that settles when the test says so, over "socket" events only. */
function fakeProject(id = 'p') {
  const project = new EventEmitter();
  Object.assign(project, { id, status: 'queued', waitingReason: null, jobs: [] });
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  project.waitForCompletion = () => done;
  project.update = status => { project.status = status; project.emit('updated', ['status']); };
  project.complete = (urls = ['https://media/r']) => { project.status = 'completed'; project.jobs = [{ id: 'job-1', status: 'completed' }]; settle.resolve(urls); };
  project.fail = error => { project.status = 'failed'; settle.reject(error); };
  return project;
}

/** A client that counts every request, so a test can prove nothing was polled. */
function fakeClient({ get = async () => stored(), elsewhere = [], getResult } = {}) {
  const calls = [];
  return {
    calls,
    projects: {
      get: async id => { calls.push(['get', id]); return get(id); },
      getResult: async (id, options) => { calls.push(['getResult', id]); return getResult(id, options); },
      listProjectsElsewhere: async () => { calls.push(['elsewhere']); return elsewhere; },
    },
  };
}

test('a project this run created is followed over the socket: no request until it finishes', async () => {
  const client = fakeClient();
  const project = fakeProject();
  const statuses = [];
  const waiting = waitForProject(client, { project }, { onStatus: status => statuses.push(status), sleep: noSleep });
  project.update('processing');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(client.calls, [], 'nothing is requested while it renders');
  project.complete();
  const record = await waiting;
  assert.equal(record.status, 'completed');
  assert.deepEqual(client.calls, [['get', 'p']], 'one read of the stored record, after it finished');
  assert.deepEqual(statuses, ['queued', 'processing']);
});

test('a failed project is a refusal, with the recorded refusal when there is one', async () => {
  const project = fakeProject();
  const waiting = waitForProject(fakeClient(), { project }, { sleep: noSleep });
  project.fail({ code: 4004, message: 'genfailure' });
  await assert.rejects(waiting, error => error instanceof RefusedError && /failed: genfailure/.test(error.message));

  const refused = fakeProject();
  const refusals = { get: id => (id === 'p' ? { code: 4047, message: 'Unsupported token type' } : null) };
  const second = waitForProject(fakeClient(), { project: refused }, { refusals, sleep: noSleep });
  refused.fail({ code: 0, message: 'whatever' });
  await assert.rejects(second, error => error instanceof RefusedError && error.failure.code === 4047);
});

test('the stored record can lag the finish: a 404 is retried briefly, a 429 waits 30 s then 60 s', async () => {
  const answers = [httpError(404), httpError(429), httpError(429), stored()];
  const client = fakeClient({ get: async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; } });
  const project = fakeProject();
  const delays = [];
  const waiting = waitForProject(client, { project }, { sleep: async ms => { delays.push(ms); } });
  project.complete();
  assert.equal((await waiting).status, 'completed');
  assert.deepEqual(delays, [5000, 30_000, 60_000]);
});

test('the safe-content filter is named when it withheld the result', async () => {
  const client = fakeClient({ get: async () => stored({ completedWorkerJobs: [{ imgID: 'r', triggeredNSFWFilter: true, nsfwDetected: false }] }) });
  const project = fakeProject();
  const waiting = waitForProject(client, { project }, { sleep: noSleep });
  project.complete();
  await assert.rejects(waiting, /safe-content filter/);
});

test('a resumed project still rendering is taken back by signing in as the app that holds it', async () => {
  const client = fakeClient({ elsewhere: [{ id: 'p', appId: 'sogni-worlds-kit-earlier' }] });
  const project = fakeProject();
  const opened = [];
  let closed = 0;
  const connectAs = async appId => {
    opened.push(appId);
    return { client: { projects: { sync: async () => {}, trackedProjects: [project] } }, close: () => { closed += 1; } };
  };
  const waiting = waitForProject(client, { projectId: 'p' }, { connectAs, sleep: noSleep });
  await new Promise(resolve => setTimeout(resolve, 20));
  project.complete();
  assert.equal((await waiting).status, 'completed');
  assert.deepEqual(opened, ['sogni-worlds-kit-earlier']);
  assert.equal(closed, 1);
  assert.deepEqual(client.calls, [['elsewhere'], ['get', 'p']]);
});

test('a resumed project that finished while nobody listened is read once, never followed', async () => {
  const client = fakeClient({ elsewhere: [] });
  const connectAs = async () => { throw new Error('must not connect'); };
  assert.equal((await waitForProject(client, { projectId: 'p' }, { connectAs, sleep: noSleep })).status, 'completed');
  assert.deepEqual(client.calls, [['elsewhere'], ['get', 'p']]);
});

test('a resumed project with no stored result is reported, not waited on forever', async () => {
  const client = fakeClient({ elsewhere: [], get: async () => { throw httpError(404); } });
  await assert.rejects(waitForProject(client, { projectId: 'p' }, { sleep: noSleep }), /no longer rendering and Sogni stored no result/);
  assert.equal(client.calls.filter(([kind]) => kind === 'get').length, 6, 'a bounded number of reads');
});

test('a resumed project is not taken from a run that is still following it', async () => {
  const client = fakeClient({ elsewhere: [{ id: 'p', appId: 'sogni-worlds-kit-earlier' }] });
  const connectAs = async () => { throw new Error('must not connect'); };
  await assert.rejects(waitForProject(client, { projectId: 'p', ownerPid: process.ppid }, { connectAs, sleep: noSleep }), /still being followed by another run/);
});

test('a project that never finishes times out with an unknown outcome, not a refusal', async () => {
  const project = fakeProject();
  await assert.rejects(waitForProject(fakeClient(), { project }, { timeoutMs: 20, sleep: noSleep }),
    error => !(error instanceof RefusedError) && /Still not finished/.test(error.message));
});

test('rateLimitDelay doubles from 30 s to a 5 min ceiling', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(rateLimitDelay), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
});

test('audio: a created project resolves with its socket result URL and no request', async () => {
  const client = fakeClient();
  const project = fakeProject();
  const waiting = waitForAudio(client, { project }, { sleep: noSleep });
  project.complete(['https://media/song.mp3']);
  assert.deepEqual(await waiting, { url: 'https://media/song.mp3', jobId: 'job-1' });
  assert.deepEqual(client.calls, []);
});

test('audio: a resumed project that finished while away is read once for its URL', async () => {
  const client = fakeClient({ elsewhere: [], getResult: async () => ({ id: 'p', status: 'completed', finished: true, jobs: [{ id: 'j', status: 'completed', url: 'https://media/song.mp3' }] }) });
  assert.deepEqual(await waitForAudio(client, { projectId: 'p' }, { sleep: noSleep }), { url: 'https://media/song.mp3', jobId: 'j' });
  assert.deepEqual(client.calls, [['elsewhere'], ['getResult', 'p']]);
});
