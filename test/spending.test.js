import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { importSpendingJournals, recordAttempt, recordCoverage, recordFunding, recordRefund, recordSelection, readSpending, spendingReport, spendingFile, trackSpending } from '../cli/lib/spending.js';
import { fetchStoredRecord } from '../cli/lib/sogni.js';

const dir = () => mkdtempSync(join(tmpdir(), 'world-spend-'));
const receipt = (projectId, usd, extra = {}) => ({ provider: 'sogni', projectId, kind: 'video', model: 'seedance', currency: 'spark', status: 'completed', charge: { usd, tokens: '1000', currency: 'spark' }, ...extra });

test('lifetime, used clips and all clips count unique paid attempts, not funding or output copies', () => {
  const root = dir();
  recordFunding(root, { reference: 'grant-1', provider: 'sogni', kind: 'credit', currency: 'spark', amount: '40000', creditValueUSD: '200', cashUSD: '0' });
  recordFunding(root, { reference: 'buy-1', provider: 'sogni', kind: 'purchase', currency: 'spark', amount: '10000', cashUSD: '50' });
  recordAttempt(root, receipt('used', '5.25'));
  recordAttempt(root, receipt('unused-retake', '4.75'));
  recordAttempt(root, receipt('failed-but-charged', '1.5', { status: 'failed' }));
  recordAttempt(root, receipt('still', '0.1', { kind: 'image' }));
  recordAttempt(root, receipt('used', '5.25', { id: 'second-tool-same-project' }));
  recordSelection(root, 'build:clips', ['used', 'used']);
  const report = spendingReport(root);
  assert.equal(report.project.usd, '11.6');
  assert.equal(report.clips.allAttempts.usd, '11.5');
  assert.equal(report.clips.allAttempts.attempts, 3);
  assert.equal(report.clips.used.usd, '5.25');
  assert.equal(report.funding.cashUSD, '50');
  assert.equal(report.funding.creditValueUSD, '200');
  recordSelection(root, 'build:clips', ['unused-retake']);
  assert.equal(spendingReport(root).clips.used.usd, '4.75');
  assert.equal(spendingReport(root).project.usd, '11.6', 'retiring a clip never removes its spend');
});

test('quotes and missing historical costs are not silently converted into actual zero charges', () => {
  const root = dir();
  recordAttempt(root, { provider: 'sogni', projectId: 'uncertain', kind: 'video', estimate: { usd: '12.3' } });
  recordSelection(root, 'build:clips', ['uncertain', 'missing-receipt']);
  const report = spendingReport(root);
  assert.equal(report.project.unknown, 1);
  assert.equal(report.project.settled, 0);
  assert.equal(report.project.estimatedUSD, '12.3');
  assert.equal(report.coverage, null);
  assert.deepEqual(report.selectedProjectsWithoutReceipts, ['sogni:missing-receipt']);
});

test('credit imports are idempotent, cash cannot masquerade as a comp, and conflicting receipts fail', () => {
  const root = dir();
  const funding = { reference: 'credit-id', kind: 'credit', provider: 'vendor', currency: 'USD-credit', amount: '200', cashUSD: '0', creditValueUSD: '200' };
  recordFunding(root, funding); recordFunding(root, funding);
  assert.equal(spendingReport(root).funding.receipts, 1);
  assert.throws(() => recordFunding(root, { ...funding, amount: '201' }), /different amounts/);
  assert.throws(() => recordFunding(root, { ...funding, reference: 'wrong', cashUSD: '200' }), /not a cash purchase/);
  assert.throws(() => recordFunding(root, { ...funding, amount: 'NaN' }), /Invalid/);
  assert.equal(spendingReport(root).funding.cashUSD, '0');
});

test('refunds lower net charges once, including through duplicate imported project receipts', () => {
  const root = dir();
  recordAttempt(root, receipt('p', '5'));
  const refund = { reference: 'refund-1', attemptId: 'sogni:p', usd: '2', tokens: '400' };
  recordRefund(root, refund); recordRefund(root, refund);
  recordAttempt(root, receipt('p', '5', { id: 'imported-again' }));
  assert.equal(spendingReport(root).project.usd, '3');
  assert.equal(spendingReport(root).project.currencies['sogni:spark'], '600');
  assert.throws(() => recordRefund(root, { ...refund, reference: 'too-much', usd: '6' }), /exceeds/);
  assert.throws(() => recordRefund(root, { ...refund, attemptId: 'imported-again', reference: 'alias-over-refund', usd: '4' }), /exceeds/);
});

test('small exact decimal/scientific costs add without floating-point drift', () => {
  const root = dir();
  recordAttempt(root, receipt('a', '0.1'));
  recordAttempt(root, receipt('b', '0.2'));
  recordAttempt(root, receipt('c', '1e-7'));
  assert.equal(spendingReport(root).project.usd, '0.3000001');
});

test('a corrected settlement wins by event order across aliases of the same project', () => {
  const root = dir();
  recordAttempt(root, receipt('a', '5'));
  assert.throws(() => recordAttempt(root, receipt('a', '6', { id: 'alias' })), /Conflicting confirmed/);
  recordAttempt(root, receipt('a', '6', { id: 'alias', correctionReference: 'vendor-adjustment-1' }));
  recordAttempt(root, receipt('a', '4', { correctionReference: 'vendor-adjustment-2' }));
  assert.equal(spendingReport(root).project.usd, '4');
  assert.equal(spendingReport(root).project.attempts, 1);
});

test('imported plan value and verified historical scope stay separate from usage charges', () => {
  const root = dir();
  recordAttempt(root, receipt('covered', '0', { charge: { usd: '0', tokens: '0', currency: 'spark' }, planValueUSD: '6.00' }));
  recordCoverage(root, { trackedSince: '2026-11-02T00:00:00Z', historicalCoverage: 'All supplied source receipts and funding imported; one failed attempt still lacks a settlement.' });
  const report = spendingReport(root);
  assert.equal(report.project.usd, '0');
  assert.equal(report.project.planValueUSD, '6');
  assert.match(report.coverage.historicalCoverage, /one failed attempt/);
});

test('SDK call is journaled before paying, settlement is captured once and existing record read is reused', async () => {
  const root = dir(); let creates = 0, gets = 0; const request = { type: 'video', modelId: 'seedance', tokenType: 'spark', billingMode: 'tokens', positivePrompt: 'private prompt' };
  const project = { id: 'p', waitForCompletion: async () => ['url'] };
  const client = { projects: {
    create: async given => { assert.equal(given, request); assert.equal(Object.values(readSpending(root).attempts)[0].status, 'submitting'); creates++; return project; },
    get: async () => { gets++; return { status: 'completed', costActual: { costInUSD: '4.5', costInToken: '900' } }; },
  } };
  trackSpending(client, root);
  assert.equal(await client.projects.create(request), project);
  assert.deepEqual(await project.waitForCompletion(), ['url']);
  assert.equal((await fetchStoredRecord(client, 'p')).status, 'completed');
  assert.equal(creates, 1); assert.equal(gets, 1, 'no history query or duplicate cost lookup');
  assert.equal(spendingReport(root).project.usd, '4.5');
  assert.equal(readFileSync(spendingFile(root), 'utf8').includes('private prompt'), false);
});

test('subscription value is separate from charged tokens; missing cost lookup preserves the media', async () => {
  for (const subscription of [true, false]) {
    const root = dir(); const warnings = [];
    const project = { id: 'p', waitForCompletion: async () => ['url'] };
    const client = { projects: { create: async () => project, get: async () => { if (!subscription) throw Object.assign(Error('late'), { status: 404 }); return { status: 'completed', costActual: { costInUSD: '10', costInToken: '2000' } }; } } };
    trackSpending(client, root, { warn: x => warnings.push(x) });
    await client.projects.create({ type: 'video', billingMode: subscription ? 'subscription' : 'tokens' });
    assert.deepEqual(await project.waitForCompletion(), ['url']);
    const report = spendingReport(root);
    assert.equal(report.project.usd, '0');
    assert.equal(report.project.unknown, subscription ? 0 : 1);
    assert.equal(report.project.planValueUSD, subscription ? '10' : '0');
    assert.equal(warnings.length, subscription ? 0 : 1);
  }
});

test('local legacy migration is idempotent, keeps quotes separate and never reads media or follows symlinks', async () => {
  const root = dir();
  mkdirSync(join(root, 'renders', 'old'), { recursive: true });
  writeFileSync(join(root, 'renders', 'old', 'take-1.json'), JSON.stringify({ projectId: 'old', model: 'video-model', quote: { usd: 5 }, status: 'completed' }));
  writeFileSync(join(root, 'renders', 'old', 'take-2.json'), JSON.stringify({ model: 'video-model', status: 'submitting' }));
  writeFileSync(join(root, 'renders', 'old', 'take-1.mp4'), 'not a JSON document');
  importSpendingJournals(root); importSpendingJournals(root);
  let report = spendingReport(root);
  assert.equal(report.project.attempts, 2);
  assert.equal(report.project.unknown, 2);
  assert.equal(report.project.estimatedUSD, '5');
  let reads = 0;
  const client = { projects: { create() {}, get: async id => { assert.equal(id, 'old'); reads++; return { status: 'completed', costActual: { costInUSD: '4', costInToken: '800' } }; } } };
  const ledger = trackSpending(client, root);
  await ledger.readActual('old'); await ledger.readActual('old');
  report = spendingReport(root);
  assert.equal(reads, 1);
  assert.equal(report.project.usd, '4');
  assert.equal(report.project.unknown, 1);
  assert.match(report.coverage.historicalCoverage, /earlier LLM calls/);
  recordSelection(root, 'custom:clips', ['old'], { unidentified: 2 });
  assert.equal(spendingReport(root).selectedClipsWithoutProjectIds, 2);
});

test('external writer calls are recorded before HTTP and remain unresolved without a vendor receipt', async () => {
  const { Llm, MODELS } = await import('../cli/lib/llm.js');
  const root = dir(); const previousURL = process.env.SOGNI_AGENT_WRITER_URL; const originalFetch = globalThis.fetch;
  process.env.SOGNI_AGENT_WRITER_URL = 'http://example.invalid/v1';
  const client = { projects: { create() {} } };
  trackSpending(client, root);
  globalThis.fetch = async () => {
    assert.equal(spendingReport(root).project.attempts, 1);
    return { ok: true, json: async () => ({ id: 'external-id', choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) };
  };
  try {
    const llm = new Llm({ client, billing: { mode: 'tokens', tokenType: 'spark' } });
    assert.equal((await llm.complete({ model: MODELS.writer, messages: [] })).content, 'answer');
    assert.equal(spendingReport(root).project.unknown, 1);
    assert.equal(Object.values(readSpending(root).attempts)[0].provider, 'external-writer');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousURL === undefined) delete process.env.SOGNI_AGENT_WRITER_URL; else process.env.SOGNI_AGENT_WRITER_URL = previousURL;
  }
});

test('an uncertain submission remains an unknown charge, not a free failed render', async () => {
  const root = dir(); const error = Error('transport lost');
  const client = { projects: { create: async () => { throw error; } } };
  trackSpending(client, root);
  await assert.rejects(client.projects.create({ type: 'video' }), e => e === error);
  assert.equal(spendingReport(root).project.unknown, 1);
});

test('streamed LLM charges are recorded even if the caller later rejects the answer', async () => {
  const root = dir();
  const stream = { finalResult: { cost: { costInUSD: '0.0123', costInToken: '2.46' } }, [Symbol.asyncIterator]() { let sent = false; return { next: async () => sent ? { done: true } : (sent = true, { done: false, value: { content: 'invalid JSON' } }) }; } };
  const client = { projects: { create() {} }, chat: { completions: { create: async () => stream } } };
  trackSpending(client, root);
  let answer = '';
  for await (const chunk of await client.chat.completions.create({ model: 'writer', billingMode: 'tokens' })) answer += chunk.content;
  assert.equal(answer, 'invalid JSON');
  assert.equal(spendingReport(root).project.usd, '0.0123');
});

test('canceling a stream retains an unknown charge and forwards iterator cancellation', async () => {
  const root = dir(); let canceled = false;
  const stream = { [Symbol.asyncIterator]() { return { next: async () => ({ done: false, value: { content: 'a' } }), return: async () => { canceled = true; return { done: true }; } }; } };
  const client = { projects: { create() {} }, chat: { completions: { create: async () => stream } } };
  trackSpending(client, root);
  for await (const ignored of await client.chat.completions.create({ model: 'writer' })) { void ignored; break; }
  assert.equal(canceled, true);
  assert.equal(spendingReport(root).project.unknown, 1);
});

test('damaged accounting prevents another submission; the report is a local CLI operation', () => {
  const root = dir(); mkdirSync(join(root, 'spending')); writeFileSync(spendingFile(root), '{broken');
  let creates = 0;
  assert.throws(() => trackSpending({ projects: { create() { creates++; } } }, root), /damaged/);
  assert.equal(creates, 0);
  rmSync(spendingFile(root)); recordAttempt(root, receipt('p', '1'));
  const report = JSON.parse(execFileSync(process.execPath, ['world.js', 'spend', '--project', root, '--json', '--no-update-check'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
  assert.equal(report.project.usd, '1');
});

test('parallel CLI processes append without overwriting each other’s paid attempts', async () => {
  const root = dir();
  const module = new URL('../cli/lib/spending.js', import.meta.url).href;
  const script = `import { appendSpending } from ${JSON.stringify(module)}; for(let i=0;i<20;i++) appendSpending(process.argv[1], {type:'attempt',data:{id:process.argv[2]+':'+i,provider:'sogni',projectId:process.argv[2]+':'+i,kind:'video'}});`;
  await Promise.all(['one', 'two', 'three', 'four'].map(prefix => new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script, root, prefix], error => error ? reject(error) : resolve());
  })));
  assert.equal(spendingReport(root).project.attempts, 80);
  assert.equal(readFileSync(spendingFile(root), 'utf8').trim().split('\n').length, 80);
});
