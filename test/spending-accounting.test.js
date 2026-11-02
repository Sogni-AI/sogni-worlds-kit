import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendSpending, importSpendingJournals, recordAttempt, recordRefund, spendingReport, trackSpending } from '../cli/lib/spending.js';

const dir = t => {
  const root = mkdtempSync(join(tmpdir(), 'world-spend-accounting-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const receipt = (projectId, usd, extra = {}) => ({
  provider: 'sogni', projectId, kind: 'video', model: 'seedance',
  charge: { usd, tokens: usd, currency: 'spark' }, ...extra,
});

test('metadata-only receipt and journal imports preserve the latest corrected charge across aliases', t => {
  const root = dir(t);
  recordAttempt(root, receipt('p', '5'));
  recordAttempt(root, receipt('p', '6', { id: 'corrected-alias', correctionReference: 'adjust-1' }));
  recordAttempt(root, { provider: 'sogni', projectId: 'p', kind: 'video', status: 'completed' });
  assert.equal(spendingReport(root).project.usd, '6');

  mkdirSync(join(root, 'renders', 'old'), { recursive: true });
  writeFileSync(join(root, 'renders', 'old', 'take-1.json'), JSON.stringify({ projectId: 'p', model: 'seedance', status: 'completed' }));
  importSpendingJournals(root);
  const report = spendingReport(root);
  assert.equal(report.project.usd, '6');
  assert.equal(report.project.attempts, 1);
  assert.equal(report.project.unknown, 0);
});

test('replaying an applied correction preserves a newer adjustment for default IDs and fresh aliases', t => {
  const root = dir(t);
  recordAttempt(root, receipt('p', '5'));
  const first = receipt('p', '6', { correctionReference: 'adjust-1' });
  recordAttempt(root, first);
  recordAttempt(root, receipt('p', '4', { correctionReference: 'adjust-2' }));

  recordAttempt(root, first);
  assert.equal(spendingReport(root).project.usd, '4');
  recordAttempt(root, { ...first, id: 'same-adjustment-another-tool' });
  const report = spendingReport(root);
  assert.equal(report.project.usd, '4');
  assert.equal(report.project.attempts, 1);
});

test('old ledgers that already contain correction replays retain the newest distinct adjustment', t => {
  const root = dir(t);
  const write = data => appendSpending(root, { type: 'attempt', data });
  const first = receipt('p', '6', { id: 'sogni:p', correctionReference: 'adjust-1' });
  write(receipt('p', '5', { id: 'sogni:p' }));
  write(first);
  write(receipt('p', '4', { id: 'sogni:p', correctionReference: 'adjust-2' }));
  // The old implementation allowed both forms of an earlier adjustment to
  // reach the append-only ledger. Reading them must not reinstate that bill.
  write(first);
  write({ ...first, id: 'old-replay-alias' });
  assert.equal(spendingReport(root).project.usd, '4');
  recordRefund(root, { reference: 'refund-via-old-alias', attemptId: 'old-replay-alias', usd: '4', tokens: '4' });
  assert.equal(spendingReport(root).project.usd, '0');
});

test('a correction reference cannot be reused with a different confirmed charge', t => {
  const root = dir(t);
  recordAttempt(root, receipt('p', '5'));
  recordAttempt(root, receipt('p', '6', { correctionReference: 'adjust-1' }));

  for (const extra of [{}, { id: 'conflicting-alias' }]) {
    assert.throws(() => recordAttempt(root, receipt('p', '4', { ...extra, correctionReference: 'adjust-1' })));
    assert.equal(spendingReport(root).project.usd, '6');
  }
});

test('an imported attempt ID cannot be rebound to another provider or project', t => {
  const root = dir(t);
  recordAttempt(root, receipt('first-project', '5', { id: 'receipt-1' }));

  assert.throws(() => recordAttempt(root, receipt('second-project', '7', { id: 'receipt-1' })));
  assert.throws(() => recordAttempt(root, receipt('first-project', '7', { id: 'receipt-1', provider: 'other-vendor' })));
  assert.throws(() => recordAttempt(root, { id: 'receipt-1', provider: 'sogni', projectId: 'unpriced-project', kind: 'video' }));
  const report = spendingReport(root);
  assert.equal(report.project.usd, '5');
  assert.equal(report.project.attempts, 1);
});

test('refunds against an original alias use the newer larger corrected charge', t => {
  const root = dir(t);
  recordAttempt(root, receipt('p', '5'));
  recordAttempt(root, receipt('p', '10', { id: 'corrected-alias', correctionReference: 'adjust-1' }));

  recordRefund(root, { reference: 'refund-first', attemptId: 'sogni:p', usd: '3', tokens: '3' });
  recordRefund(root, { reference: 'refund-rest', attemptId: 'corrected-alias', usd: '7', tokens: '7' });
  const report = spendingReport(root);
  assert.equal(report.project.usd, '0');
  assert.equal(report.project.currencies['sogni:spark'], '0');
  assert.equal(report.project.attempts, 1);
  assert.throws(() => recordRefund(root, { reference: 'over-refund', attemptId: 'sogni:p', usd: '1', tokens: '1' }));
  assert.equal(spendingReport(root).project.usd, '0');
});

test('a stale larger alias cannot accept a refund beyond the current corrected charge', t => {
  const root = dir(t);
  recordAttempt(root, receipt('p', '10'));
  recordAttempt(root, receipt('p', '5', { id: 'corrected-alias', correctionReference: 'adjust-1' }));

  assert.throws(() => recordRefund(root, { reference: 'too-large', attemptId: 'sogni:p', usd: '8', tokens: '8' }));
  assert.equal(spendingReport(root).project.usd, '5', 'a rejected refund must leave the report usable');
  recordRefund(root, { reference: 'full-refund', attemptId: 'sogni:p', usd: '5', tokens: '5' });
  assert.equal(spendingReport(root).project.usd, '0');
});

test('corrections cannot reduce gross USD or token charges below refunds recorded through aliases', t => {
  const root = dir(t);
  const charge = (usd, tokens) => ({ usd, tokens, currency: 'spark' });
  recordAttempt(root, receipt('p', '10', { charge: charge('10', '1000') }));
  recordAttempt(root, receipt('p', '10', { id: 'duplicate-alias', charge: charge('10', '1000') }));
  recordRefund(root, { reference: 'partial-refund', attemptId: 'duplicate-alias', usd: '3', tokens: '300' });

  assert.throws(() => recordAttempt(root, receipt('p', '2', { correctionReference: 'invalid-usd', charge: charge('2', '1000') })));
  assert.throws(() => recordAttempt(root, receipt('p', '10', { id: 'new-correction-alias', correctionReference: 'invalid-tokens', charge: charge('10', '200') })));
  const report = spendingReport(root);
  assert.equal(report.project.usd, '7');
  assert.equal(report.project.currencies['sogni:spark'], '700');

  recordAttempt(root, receipt('p', '9', { correctionReference: 'valid-adjustment', charge: charge('9', '900') }));
  assert.equal(spendingReport(root).project.usd, '6');
  assert.equal(spendingReport(root).project.currencies['sogni:spark'], '600');
});

test('a positive paid correction clears plan value from the superseded zero-charge settlement', t => {
  for (const correctionId of [undefined, 'corrected-alias']) {
    const root = dir(t);
    recordAttempt(root, receipt('p', '0', { planValueUSD: '6' }));
    recordAttempt(root, receipt('p', '4', { ...(correctionId ? { id: correctionId } : {}), correctionReference: 'actually-paid' }));
    const report = spendingReport(root);
    assert.equal(report.project.usd, '4');
    assert.equal(report.project.planValueUSD, '0');
    assert.equal(report.models['sogni:seedance'].planValueUSD, '0');
  }
});

test('an ordinary duplicate zero-charge receipt preserves its known optional plan value', t => {
  const root = dir(t);
  recordAttempt(root, receipt('p', '0', { planValueUSD: '6' }));
  recordAttempt(root, receipt('p', '0'));
  assert.equal(spendingReport(root).project.planValueUSD, '6');
  recordAttempt(root, receipt('p', '0', { id: 'another-tool-same-covered-job' }));
  assert.equal(spendingReport(root).project.planValueUSD, '6');
});

test('reimporting the current correction can supply its previously unknown optional plan value', t => {
  for (const enrichmentId of [undefined, 'enriched-receipt-alias']) {
    const root = dir(t);
    const correction = receipt('p', '0', { correctionReference: 'covered-adjustment' });
    recordAttempt(root, correction);
    recordAttempt(root, { ...correction, ...(enrichmentId ? { id: enrichmentId } : {}), planValueUSD: '6' });
    const report = spendingReport(root);
    assert.equal(report.project.usd, '0');
    assert.equal(report.project.planValueUSD, '6');
    assert.equal(report.project.attempts, 1);
    assert.equal(report.project.settled, 1);
    assert.throws(() => recordAttempt(root, { ...correction, planValueUSD: '7' }));
    assert.equal(spendingReport(root).project.planValueUSD, '6');
  }
});

test('enriching a superseded correction never replaces a newer paid or covered settlement', t => {
  for (const latest of [{ usd: '4', expectedPlan: '0' }, { usd: '0', planValueUSD: '8', expectedPlan: '8' }]) {
    const root = dir(t);
    const older = receipt('p', '0', { correctionReference: 'older-covered-adjustment' });
    recordAttempt(root, older);
    recordAttempt(root, receipt('p', latest.usd, { id: 'latest-settlement-alias', correctionReference: 'latest-adjustment', ...(latest.planValueUSD ? { planValueUSD: latest.planValueUSD } : {}) }));
    recordAttempt(root, { ...older, planValueUSD: '6' });
    recordAttempt(root, { ...older, id: 'older-enriched-alias', planValueUSD: '6' });
    recordAttempt(root, { provider: 'sogni', projectId: 'p', kind: 'video', status: 'completed' });
    const report = spendingReport(root);
    assert.equal(report.project.usd, latest.usd);
    assert.equal(report.project.planValueUSD, latest.expectedPlan);
    assert.equal(report.project.attempts, 1);
    assert.equal(report.project.unknown, 0);
  }
});

test('real writer settlement precision is preserved and added without rounding', async t => {
  const root = dir(t);
  const model = 'deepseek-v4-flash-vision-exp-dspark-1m';
  // Producer-derived Socket receipt: 1000 input / 24 output tokens at the
  // 2026-11-02 writer rate. BigNumber construction preserves this 20-place USD.
  const cost = { costInUSD: '0.00041600000000000003', costInToken: '0.08320000000000001' };
  const stream = {
    jobID: 'precise-writer-call', finalResult: { cost },
    async *[Symbol.asyncIterator]() { yield { content: 'answer' }; },
  };
  const warnings = [];
  const client = { projects: { create() {} }, chat: { completions: { create: async () => stream } } };
  trackSpending(client, root, { warn: warning => warnings.push(warning) });
  for await (const chunk of await client.chat.completions.create({ model, tokenType: 'spark', billingMode: 'tokens' })) void chunk;
  const captured = spendingReport(root);
  assert.equal(captured.project.usd, cost.costInUSD);
  assert.equal(captured.project.currencies['sogni:spark'], cost.costInToken);
  assert.equal(captured.project.settled, 1);
  assert.equal(captured.project.unknown, 0);
  assert.deepEqual(warnings, []);

  recordAttempt(root, receipt('another-price', '0.00000000000000000001', { kind: 'llm', model }));
  const combined = spendingReport(root);
  assert.equal(combined.project.usd, '0.00041600000000000004');
  assert.equal(combined.project.currencies['sogni:spark'], '0.08320000000000001001');
  assert.equal(combined.project.settled, 2);
});
