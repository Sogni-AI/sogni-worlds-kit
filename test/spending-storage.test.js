import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { events, readSpending, spendingFile, spendingReport, trackSpending } from '../cli/lib/spending.js';
import { tempDir } from './helpers.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const spendingModule = new URL('../cli/lib/spending.js', import.meta.url).href;
const fixture = t => {
  const root = tempDir('spending-storage');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const receiptFile = (root, name, entry) => {
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entry));
  return file;
};
const launch = (args, options = {}) => {
  let finished = false;
  let child;
  const result = new Promise(resolve => {
    child = execFile(process.execPath, args, { cwd: repo, maxBuffer: 1024 * 1024, timeout: 30_000, ...options }, (error, stdout, stderr) => {
      finished = true;
      resolve({ code: error?.code ?? 0, signal: error?.signal, stdout, stderr });
    });
  });
  return { child, result, get finished() { return finished; } };
};
const cli = (root, args, options) => launch(['world.js', 'spend', '--project', root, ...args, '--json', '--no-update-check'], options);
const waitFor = async (file, worker) => {
  const until = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (worker?.finished) assert.fail(`Child exited before creating ${file}: ${JSON.stringify(await worker.result)}`);
    assert.ok(Date.now() < until, `Timed out waiting for ${file}`);
    await delay(10);
  }
};
const funding = amount => ({ type: 'funding', data: { reference: 'one-receipt', provider: 'sogni', kind: 'purchase', currency: 'spark', amount, cashUSD: amount } });

for (const kind of ['funding', 'attempt']) {
  test(`parallel CLI ${kind} imports accept one conflicting receipt and leave readable history`, async t => {
    const root = fixture(t);
    mkdirSync(join(root, 'spending'), { recursive: true });
    // A real historical journal makes the former read/check/append race reproducible.
    const coverage = JSON.stringify({ schema: 1, type: 'coverage', data: { trackedSince: '2026-11-02T00:00:00Z', historicalCoverage: 'Offline fixture' } }) + '\n';
    writeFileSync(spendingFile(root), coverage.repeat(35_000));
    const gate = join(root, 'start');
    const barrier = `import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(process.env.SPEND_TEST_READY, 'ready'); while (!existsSync(process.env.SPEND_TEST_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`;
    const workers = Array.from({ length: 4 }, (_, n) => {
      const amount = String(n + 1);
      const entry = kind === 'funding' ? funding(amount) : { type: 'attempt', data: { provider: 'sogni', projectId: 'one-project', kind: 'video', charge: { usd: amount, tokens: amount, currency: 'spark' } } };
      const file = receiptFile(root, `receipt-${n}.json`, entry);
      const ready = join(root, `ready-${n}`);
      const worker = launch(['--import', `data:text/javascript,${encodeURIComponent(barrier)}`, 'world.js', 'spend', '--project', root, '--record', file, '--json', '--no-update-check'], { env: { ...process.env, SPEND_TEST_READY: ready, SPEND_TEST_GATE: gate } });
      t.after(() => { if (!worker.finished) worker.child.kill('SIGKILL'); });
      return { worker, ready };
    });
    await Promise.all(workers.map(({ ready, worker }) => waitFor(ready, worker)));
    writeFileSync(gate, 'go');
    const results = await Promise.all(workers.map(({ worker }) => worker.result));
    assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
    for (const rejected of results.filter(r => r.code !== 0)) assert.match(rejected.stderr, /different amounts|conflicting confirmed charge/i);
    const saved = events(root).filter(event => event.type === kind);
    assert.equal(saved.length, 1, 'conflicting receipts must not be committed before rejection');
    const report = spendingReport(root);
    assert.equal(kind === 'funding' ? report.funding.cashUSD : report.project.usd, kind === 'funding' ? saved[0].data.cashUSD : saved[0].data.charge.usd);
    const again = await cli(root, []).result;
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotThrow(() => JSON.parse(again.stdout));
  });
}

test('journal migration retains both actual retake archive filename formats', async t => {
  const root = fixture(t);
  const names = [
    'audio/music/music.json',
    'audio/music/2026-10-31T10-00-00-000Z.music.json.old',
    'audio/narration/a.2026-10-31T10-00-00-000Z.json.old',
    'voices/narrator.designed.receipt.json.1793469600000.old',
  ];
  names.forEach((name, n) => receiptFile(root, name, { projectId: `historical-${n}`, model: 'fixture', status: 'completed', costActual: { costInUSD: String(n + 1), costInToken: String((n + 1) * 200) } }));
  for (let n = 0; n < 2; n++) {
    const result = await cli(root, ['--import-journals']).result;
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.project.attempts, 4);
    assert.equal(report.project.usd, '10', 'historical rerolls retain their charges across repeat imports');
    assert.equal(report.project.currencies['sogni:spark'], '2000');
  }
});

test('journal migration retains a failed submission without a project ID as an unknown charge', async t => {
  const root = fixture(t);
  receiptFile(root, 'renders/a-loop/take-1.json', { film: 'a-loop', take: 1, model: 'fixture', projectId: null, status: 'failed', quote: { usd: '3' }, failure: { code: 123, message: 'No project ID returned' } });
  const result = await cli(root, ['--import-journals']).result;
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.project.attempts, 1);
  assert.equal(report.project.unknown, 1);
  assert.equal(report.project.settled, 0);
  assert.equal(report.project.usd, '0');
  assert.equal(Object.values(readSpending(root).attempts)[0].kind, 'video');
});

test('a running client checks newly damaged spending history before its next paid submission', async t => {
  const root = fixture(t);
  let creates = 0;
  const client = { projects: { create: async () => ({ id: `project-${++creates}` }) } };
  trackSpending(client, root);
  await client.projects.create({ type: 'video', billingMode: 'tokens' });
  appendFileSync(spendingFile(root), '{damaged');
  await assert.rejects(client.projects.create({ type: 'video', billingMode: 'tokens' }), /damaged spending record/);
  assert.equal(creates, 1, 'the second paid create must never run');
});

const pausedWriter = (root, t) => {
  const held = join(root, 'writer-held');
  const release = join(root, 'writer-release');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const open = fs.openSync;
    fs.openSync = function(file, flags, ...args) {
      if (String(file).endsWith('/spending/ledger.jsonl') && flags === 'a') {
        fs.writeFileSync(${JSON.stringify(held)}, 'held');
        while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return open.call(this, file, flags, ...args);
    };
    syncBuiltinESMExports();
    const { recordFunding } = await import(${JSON.stringify(spendingModule)});
    recordFunding(${JSON.stringify(root)}, ${JSON.stringify(funding('1').data)});
  `;
  const worker = launch(['--input-type=module', '-e', script]);
  t.after(() => { if (!worker.finished) worker.child.kill('SIGKILL'); });
  return { ...worker, held, release, get finished() { return worker.finished; } };
};

test('a live writer retains its transaction until append finishes', async t => {
  const root = fixture(t);
  const owner = pausedWriter(root, t);
  await waitFor(owner.held, owner);
  const attempting = join(root, 'contender-attempting');
  const script = `
    import { writeFileSync } from 'node:fs';
    const { recordFunding } = await import(${JSON.stringify(spendingModule)});
    writeFileSync(${JSON.stringify(attempting)}, 'attempting');
    try { recordFunding(${JSON.stringify(root)}, ${JSON.stringify(funding('2').data)}); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const contender = launch(['--input-type=module', '-e', script]);
  t.after(() => { if (!contender.finished) contender.child.kill('SIGKILL'); });
  await waitFor(attempting, contender);
  await delay(200);
  assert.equal(contender.finished, false, 'a live transaction cannot be replaced');
  writeFileSync(owner.release, 'go');
  const first = await owner.result;
  const second = await contender.result;
  assert.equal(first.code, 0, first.stderr);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /different amounts/i);
  assert.equal(spendingReport(root).funding.cashUSD, '1');
  assert.equal(events(root).filter(event => event.type === 'funding').length, 1);
});

test('a writer killed while holding its transaction does not prevent the next CLI import', async t => {
  const root = fixture(t);
  const owner = pausedWriter(root, t);
  await waitFor(owner.held, owner);
  owner.child.kill('SIGKILL');
  assert.equal((await owner.result).signal, 'SIGKILL');
  const file = receiptFile(root, 'recovered.json', funding('2'));
  const recovered = await cli(root, ['--record', file]).result;
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).funding.cashUSD, '2');
  assert.equal(events(root).filter(event => event.type === 'funding').length, 1);
});
