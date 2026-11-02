import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Project from '../node_modules/@sogni-ai/sogni-client/dist-esm/Projects/Project.js';
import ChatStream from '../node_modules/@sogni-ai/sogni-client/dist-esm/Chat/ChatStream.js';
import { trackSpending, readSpending, recordAttempt, spendingFile, spendingReport } from '../cli/lib/spending.js';
import { fetchStoredRecord, RefusedError, settleProject, waitForProject } from '../cli/lib/sogni.js';
import { waitForAudio } from '../cli/lib/audio.js';
import { FIGURE_MODELS, meshJob } from '../cli/lib/figures.js';
import { Llm, MODELS } from '../cli/lib/llm.js';

const cost = { costInUSD: '0.25', costInToken: '50' };
const resultURL = 'https://offline.invalid/result';
const rootFor = t => {
  const root = mkdtempSync(join(tmpdir(), 'world-spending-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const completedProject = () => ({
  id: 'P', status: 'completed', finished: true,
  jobs: [{ id: 'J', status: 'completed' }],
  waitForCompletion: async () => [resultURL],
});
const stored = (extra = {}) => ({ status: 'completed', costActual: cost, completedWorkerJobs: [], ...extra });
const disableLedger = root => {
  const file = spendingFile(root);
  renameSync(file, `${file}.saved`);
  mkdirSync(file);
  return () => { rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file); };
};
const readyStream = () => {
  const stream = new ChatStream('LLM-P');
  stream._pushChunk({ jobID: stream.jobID, content: 'answer' });
  stream._setCost({ ...cost, costInSogni: '1', costInSpark: '50', inputTokens: 2, outputTokens: 1 });
  stream._complete(1, { prompt_tokens: 2, completion_tokens: 1 });
  return stream;
};

test('video settlement shares its required result read and backs off on its first 429', async t => {
  const root = rootFor(t), project = completedProject(), delays = [];
  let gets = 0;
  const client = { projects: {
    create: async () => project,
    get: async () => {
      if (++gets === 1) throw Object.assign(Error('rate limited'), { status: 429, retryAfter: 60 });
      return stored();
    },
  } };
  trackSpending(client, root, { warn() {} });
  await client.projects.create({ type: 'video', modelId: 'video-model', billingMode: 'tokens' });
  assert.equal((await waitForProject(client, { project }, { sleep: async delay => delays.push(delay) })).status, 'completed');
  assert.equal(gets, 2);
  assert.ok(delays.length === 1 && delays[0] >= 30_000, 'the first 429 must cause a delay before another GET');
  assert.equal(spendingReport(root).project.usd, '0.25');
});

test('a live audio result survives a rate-limited cost read without immediately repeating it', async t => {
  const root = rootFor(t), project = completedProject(), warnings = [];
  let gets = 0;
  const client = { projects: {
    create: async () => project,
    get: async () => { gets++; throw Object.assign(Error('rate limited'), { status: 429, retryAfter: 60 }); },
  } };
  trackSpending(client, root, { warn: text => warnings.push(text) });
  await client.projects.create({ type: 'audio', billingMode: 'tokens' });
  assert.equal((await waitForAudio(client, { project })).url, resultURL);
  assert.equal(gets, 1);
  assert.ok(warnings.length > 0);
  assert.equal(spendingReport(root).project.unknown, 1);
});

test('an image completion captures one cost read without needing a separate media-record consumer', async t => {
  const root = rootFor(t), project = completedProject();
  let gets = 0;
  const client = { projects: { create: async () => project, get: async () => { gets++; return stored(); } } };
  trackSpending(client, root);
  await client.projects.create({ type: 'image', modelId: 'image-model', billingMode: 'tokens' });
  assert.deepEqual(await project.waitForCompletion(), [resultURL]);
  assert.equal(gets, 1);
  assert.equal(spendingReport(root).project.usd, '0.25');
});

for (const status of ['failed', 'canceled']) {
  test(`a native SDK ${status} wait captures available settlement once and preserves its original failure`, async t => {
    const root = rootFor(t), originalFailure = { code: 0, message: `Project ${status}` };
    const project = new Project({ type: 'image', numberOfMedia: 1 }, { id: status.toUpperCase(), api: {}, logger: {} });
    t.after(() => project._dispose());
    project._update({ status, error: originalFailure });
    let gets = 0;
    const client = { projects: {
      create: async () => project,
      get: async () => { gets++; return stored({ status: status === 'failed' ? 'errored' : 'cancelled', paymentModel: 'paid_spark' }); },
    } };
    trackSpending(client, root);
    await client.projects.create({ type: 'image', modelId: 'image-model', billingMode: 'tokens' });
    await assert.rejects(project.waitForCompletion(), error => error === originalFailure);
    assert.equal(gets, 1);
    assert.equal(spendingReport(root).project.usd, '0.25');
  });
}

test('a terminal settlement lookup failure never replaces the SDK failure or retries the lookup', async t => {
  const root = rootFor(t), originalFailure = { code: 0, message: 'Project canceled' };
  const project = { id: 'CANCELED', status: 'canceled', finished: true, waitForCompletion: async () => { throw originalFailure; } };
  let gets = 0;
  const client = { projects: {
    create: async () => project,
    get: async () => { gets++; throw Object.assign(Error('rate limited'), { status: 429 }); },
  } };
  trackSpending(client, root, { warn() {} });
  await client.projects.create({ type: 'image', billingMode: 'tokens' });
  await assert.rejects(project.waitForCompletion(), error => error === originalFailure);
  assert.equal(gets, 1);
  assert.equal(spendingReport(root).project.unknown, 1);
});

test('an unknown nonterminal wait failure does not trigger a speculative settlement read', async t => {
  const root = rootFor(t), originalFailure = Error('transport lost');
  const project = { id: 'PENDING', status: 'processing', finished: false, waitForCompletion: async () => { throw originalFailure; } };
  let gets = 0;
  const client = { projects: { create: async () => project, get: async () => { gets++; return stored(); } } };
  trackSpending(client, root);
  await client.projects.create({ type: 'video', billingMode: 'tokens' });
  await assert.rejects(project.waitForCompletion(), error => error === originalFailure);
  assert.equal(gets, 0);
  assert.equal(spendingReport(root).project.unknown, 1);
});

for (const [kind, wait] of [['video', waitForProject], ['audio', waitForAudio]]) {
  for (const status of ['failed', 'canceled']) {
    test(`recovered ${kind} ${status} in an untracked SDK session reconciles through its tracked outer client`, async t => {
      const root = rootFor(t), id = `${kind}-${status}`, failure = { code: 42, message: `Project ${status}` };
      recordAttempt(root, { provider: 'sogni', projectId: id, kind, status: 'submitted', currency: 'spark' });
      const project = new Project({ type: kind, numberOfMedia: 1 }, { id, api: {}, logger: {} });
      t.after(() => project._dispose());
      project._update({ status, error: failure });
      let gets = 0, syncs = 0, closes = 0;
      const client = { projects: {
        create() {},
        listProjectsElsewhere: async () => [{ id, appId: 'original-app' }],
        get: async given => { assert.equal(given, id); gets++; return stored({ status: status === 'failed' ? 'errored' : 'cancelled', paymentModel: 'paid_spark' }); },
      } };
      trackSpending(client, root, { warn() {} });
      await assert.rejects(wait(client, { projectId: id }, {
        connectAs: async appId => {
          assert.equal(appId, 'original-app');
          return { client: { projects: { sync: async mode => { assert.equal(mode, 'resume'); syncs++; }, trackedProjects: [project] } }, close: () => closes++ };
        },
      }), error => error instanceof RefusedError && error.failure.code === failure.code);
      assert.equal(syncs, 1);
      assert.equal(closes, 1);
      assert.equal(gets, 1);
      assert.equal(spendingReport(root).project.usd, '0.25');
    });
  }

  test(`already wrapped ${kind} terminal failure does not duplicate its first rate-limited settlement read`, async t => {
    const root = rootFor(t), failure = { code: 42, message: 'Project canceled' };
    const project = { id: `wrapped-${kind}`, status: 'canceled', finished: true, waitForCompletion: async () => { throw failure; } };
    let gets = 0;
    const client = { projects: {
      create: async () => project,
      get: async () => { gets++; throw Object.assign(Error('rate limited'), { status: 429, retryAfter: 60 }); },
    } };
    trackSpending(client, root, { warn() {} });
    await client.projects.create({ type: kind, billingMode: 'tokens' });
    await assert.rejects(wait(client, { project }), error => error instanceof RefusedError && error.failure.code === failure.code);
    assert.equal(gets, 1);
    assert.equal(spendingReport(root).project.unknown, 1);
  });
}

test('audio that finished with a failed getResult while offline still attempts one settlement lookup', async t => {
  const root = rootFor(t), id = 'OFFLINE-AUDIO';
  recordAttempt(root, { provider: 'sogni', projectId: id, kind: 'audio', status: 'submitted' });
  let gets = 0, resultReads = 0;
  const client = { projects: {
    create() {},
    listProjectsElsewhere: async () => [],
    getResult: async given => { assert.equal(given, id); resultReads++; return { status: 'failed', finished: true, jobs: [{ status: 'failed', reason: 'artistCanceled' }] }; },
    get: async given => { assert.equal(given, id); gets++; return stored({ status: 'cancelled', paymentModel: 'paid_spark', costActual: { costInUSD: '0', costInToken: '0' } }); },
  } };
  trackSpending(client, root, { warn() {} });
  await assert.rejects(waitForAudio(client, { projectId: id }), error => error instanceof RefusedError);
  assert.equal(resultReads, 1);
  assert.equal(gets, 1);
  assert.equal(spendingReport(root).project.settled, 1);
  assert.equal(spendingReport(root).project.usd, '0');
});

test('an accounting failure after a paid media completion preserves the result and blocks later submissions', async t => {
  const root = rootFor(t), project = completedProject(), warnings = [];
  let restores, creates = 0;
  project.waitForCompletion = async () => { restores = disableLedger(root); return [resultURL]; };
  const client = { projects: { create: async () => { creates++; return project; }, get: async () => stored() } };
  trackSpending(client, root, { warn: text => warnings.push(text) });
  await client.projects.create({ type: 'video', billingMode: 'tokens' });
  assert.deepEqual(await settleProject(project), [resultURL], 'bookkeeping must not turn a successful paid render into RefusedError');
  assert.equal((await fetchStoredRecord(client, project.id, { sleep: async () => {} })).status, 'completed');
  restores();
  await assert.rejects(client.projects.create({ type: 'video' }), error => error.spending === true);
  assert.equal(creates, 1);
  assert.ok(warnings.length > 0);
});

test('an accounting failure after paid submission still returns its recoverable SDK project', async t => {
  const root = rootFor(t), project = completedProject(), warnings = [];
  let restores, creates = 0;
  const client = { projects: {
    create: async () => { creates++; restores = disableLedger(root); return project; },
    get: async () => stored(),
  } };
  trackSpending(client, root, { warn: text => warnings.push(text) });
  assert.equal(await client.projects.create({ type: 'image', billingMode: 'tokens' }), project);
  assert.deepEqual(await project.waitForCompletion(), [resultURL]);
  restores();
  await assert.rejects(client.projects.create({ type: 'image' }), error => error.spending === true);
  assert.equal(creates, 1);
  assert.ok(warnings.length > 0);
});

test('an accounting failure after a paid LLM completion preserves its answer without retrying', async t => {
  const root = rootFor(t), stream = readyStream(), warnings = [];
  let creates = 0, restores;
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = () => {
    const iterator = iterate();
    return { ...iterator, next: async () => { const chunk = await iterator.next(); if (chunk.done) restores = disableLedger(root); return chunk; } };
  };
  const client = { projects: { create() {} }, chat: { completions: { create: async () => { creates++; return stream; } } } };
  trackSpending(client, root, { warn: text => warnings.push(text) });
  const llm = new Llm({ client, billing: { mode: 'tokens', tokenType: 'spark' } });
  assert.equal((await llm.complete({ model: MODELS.judge, messages: [] })).content, 'answer');
  restores();
  await assert.rejects(llm.complete({ model: MODELS.judge, messages: [] }), error => error.spending === true);
  assert.equal(creates, 1);
  assert.ok(warnings.length > 0);
});

test('an accounting failure after paid LLM submission still preserves its stream and final answer', async t => {
  const root = rootFor(t), stream = readyStream();
  let creates = 0, restores;
  const client = { projects: { create() {} }, chat: { completions: {
    create: async () => { creates++; restores = disableLedger(root); return stream; },
  } } };
  trackSpending(client, root, { warn() {} });
  const llm = new Llm({ client, billing: { mode: 'tokens', tokenType: 'spark' } });
  assert.equal((await llm.complete({ model: MODELS.judge, messages: [] })).content, 'answer');
  restores();
  await assert.rejects(llm.complete({ model: MODELS.judge, messages: [] }), error => error.spending === true);
  assert.equal(creates, 1);
});

test('an accounting failure before submission prevents a paid SDK call', async t => {
  const root = rootFor(t);
  let creates = 0;
  const client = { projects: { create: async () => { creates++; return completedProject(); } } };
  trackSpending(client, root);
  disableLedger(root);
  await assert.rejects(client.projects.create({ type: 'video' }));
  assert.equal(creates, 0);
});

test('historical selection settlement uses authoritative SOGNI currency instead of guessed Spark', async t => {
  const root = rootFor(t);
  mkdirSync(join(root, 'selections'));
  writeFileSync(join(root, 'selections', 'place-object.json'), JSON.stringify({ projectId: 'OLD-SAM', model: 'sam3', status: 'completed' }));
  const client = { projects: { create() {}, get: async () => stored({ tokenType: 'sogni', paymentModel: 'sogni' }) } };
  const ledger = trackSpending(client, root);
  await ledger.readActual('OLD-SAM');
  assert.deepEqual(spendingReport(root).project.currencies, { 'sogni:sogni': '50' });
});

test('authoritative free_spark payment model corrects guessed currency when a historical settlement has no tokenType', async t => {
  const root = rootFor(t);
  recordAttempt(root, { provider: 'sogni', projectId: 'OLD-FREE-SPARK', kind: 'image', currency: 'sogni' });
  const client = { projects: { create() {}, get: async () => stored({ paymentModel: 'free_spark' }) } };
  const ledger = trackSpending(client, root);
  await ledger.readActual('OLD-FREE-SPARK');
  assert.deepEqual(spendingReport(root).project.currencies, { 'sogni:spark': '50' });
});

test('real meshJob records 3D spending while retaining the SDK image transport contract', async t => {
  const root = rootFor(t), project = completedProject();
  let request;
  const client = { projects: {
    create: async given => { request = given; return project; },
    getModelOptions: async () => null,
    get: async () => stored(),
  } };
  trackSpending(client, root);
  let json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, accessors: [{ count: 3 }], meshes: [{ primitives: [{ indices: 0 }] }] }));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const glb = Buffer.alloc(20 + json.length);
  glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => glb });
  const timers = [];
  globalThis.setTimeout = (...args) => { const timer = originalTimeout(...args); timers.push(timer); return timer; };
  try {
    const result = await meshJob({ client, billing: { tokenType: 'spark', mode: 'tokens' } }, Buffer.from('offline fixture'), 'a pebble');
    assert.equal(result.glb.triangles, 1);
    assert.equal(request.type, 'image');
    assert.equal(request.modelId, FIGURE_MODELS.mesh);
    assert.equal(Object.values(readSpending(root).attempts)[0].kind, '3d');
    assert.equal(spendingReport(root).project.usd, '0.25');
  } finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout;
    for (const timer of timers) clearTimeout(timer);
  }
});
