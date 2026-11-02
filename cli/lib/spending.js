// Project lifetime accounting. One append-only local journal, written before
// submission; reports never contact Sogni or search render/history folders.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { legacyAttempts } from './spending-import.js';

const clients = new WeakMap();
const SCALE = 10n ** 18n;
const decimal = value => {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || text.length > 128) throw new Error(`Invalid nonnegative accounting amount: ${text}`);
  const fraction = match[2] ?? '';
  const power = 18 + Number(match[3] ?? 0) - fraction.length;
  if (Math.abs(power) > 100) throw new Error('Accounting amount is outside the supported range');
  const digits = BigInt(match[1] + fraction);
  if (power >= 0) return digits * 10n ** BigInt(power);
  const divisor = 10n ** BigInt(-power);
  if (digits % divisor) throw new Error('Accounting amount needs more than 18 decimal places');
  return digits / divisor;
};
const amount = value => {
  const sign = value < 0n ? '-' : '';
  const positive = value < 0n ? -value : value;
  const fraction = String(positive % SCALE).padStart(18, '0').replace(/0+$/, '');
  return `${sign}${positive / SCALE}${fraction ? `.${fraction}` : ''}`;
};
const cleanAmount = value => amount(decimal(value));
export const spendingFile = dir => join(dir, 'spending', 'ledger.jsonl');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function events(dir) {
  const file = spendingFile(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`${file}:${index + 1}: damaged spending record; restore or repair it before spending again`); }
  });
}

/** One O_APPEND write plus fsync: concurrent commands cannot overwrite history. */
export function appendSpending(dir, entry) {
  if (!dir) throw new Error('Spending needs the project directory');
  const file = spendingFile(dir);
  mkdirSync(join(dir, 'spending'), { recursive: true });
  const event = { schema: 1, id: randomUUID(), at: new Date().toISOString(), ...entry };
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  if (bytes.length > 64 * 1024) throw new Error('Spending record is unexpectedly large');
  const fd = openSync(file, 'a', 0o600);
  try { if (writeSync(fd, bytes) !== bytes.length) throw new Error('Incomplete spending write'); fsyncSync(fd); }
  catch (error) { error.spending = true; throw error; }
  finally { closeSync(fd); }
  return event;
}

export function readSpending(dir) {
  const state = { attempts: Object.create(null), attemptOrder: Object.create(null), funding: Object.create(null), selections: Object.create(null), refunds: Object.create(null), coverage: null };
  let order = 0;
  for (const event of events(dir)) {
    if (event.schema !== 1) throw new Error('Unsupported spending ledger schema');
    const { type, data } = event;
    if (type === 'attempt') { state.attempts[data.id] = { ...state.attempts[data.id], ...data }; state.attemptOrder[data.id] = order++; }
    else if (type === 'funding' || type === 'refund') {
      const map = type === 'refund' ? state.refunds : state.funding;
      if (map[data.reference] && !same(map[data.reference], data)) throw new Error(`Conflicting ${type} reference: ${data.reference}`);
      map[data.reference] = data;
    } else if (type === 'selection') state.selections[data.name] = data;
    else if (type === 'coverage') state.coverage = data;
    else throw new Error(`Unknown spending event: ${type}`);
  }
  return state;
}

export function recordFunding(dir, data) {
  if (!['credit', 'purchase'].includes(data.kind) || !data.reference?.trim() || !data.provider?.trim() || !data.currency?.trim()) throw new Error('Funding needs kind credit|purchase, provider, currency and a stable receipt reference');
  const entry = { reference: data.reference, kind: data.kind, provider: data.provider, currency: data.currency, amount: cleanAmount(data.amount), cashUSD: cleanAmount(data.cashUSD), creditValueUSD: data.creditValueUSD == null ? null : cleanAmount(data.creditValueUSD) };
  if (entry.kind === 'credit' && entry.cashUSD !== '0') throw new Error('A credit is not a cash purchase; record its actual cash cost as 0');
  const previous = readSpending(dir).funding[entry.reference];
  if (previous) { if (!same(previous, entry)) throw new Error(`Funding receipt ${entry.reference} already has different amounts`); return previous; }
  appendSpending(dir, { type: 'funding', data: entry });
  return entry;
}

export function recordRefund(dir, data) {
  if (!data.reference?.trim() || !data.attemptId) throw new Error('A refund needs its receipt reference and attemptId');
  const state = readSpending(dir);
  const attempt = state.attempts[data.attemptId];
  if (!attempt?.charge) throw new Error('Settle the attempt before recording its refund');
  const entry = { reference: data.reference, attemptId: data.attemptId, usd: cleanAmount(data.usd), tokens: cleanAmount(data.tokens), currency: attempt.charge.currency };
  const previous = state.refunds[entry.reference];
  if (previous) { if (!same(previous, entry)) throw new Error('Refund reference already has different amounts'); return previous; }
  const aliases = Object.values(state.attempts).filter(a => a.id === attempt.id || (attempt.projectId && a.provider === attempt.provider && a.projectId === attempt.projectId)).map(a => a.id);
  const prior = Object.values(state.refunds).filter(r => aliases.includes(r.attemptId));
  if (prior.reduce((n, r) => n + decimal(r.usd), decimal(entry.usd)) > decimal(attempt.charge.usd)
    || prior.reduce((n, r) => n + decimal(r.tokens), decimal(entry.tokens)) > decimal(attempt.charge.tokens)) throw new Error('Refund exceeds the recorded charge');
  appendSpending(dir, { type: 'refund', data: entry });
  return entry;
}

/** A successful build replaces its selection; retired clips stay in lifetime spend. */
export function recordSelection(dir, name, projectIds, { unidentified = 0 } = {}) {
  if (!name?.trim() || !Array.isArray(projectIds) || !projectIds.every(x => typeof x === 'string' && x)) throw new Error('Selection needs a name and project IDs');
  if (!Number.isSafeInteger(unidentified) || unidentified < 0) throw new Error('Unidentified clip count must be a nonnegative integer');
  const data = { name, projectIds: [...new Set(projectIds.map(id => id.includes(':') ? id : `sogni:${id}`))].sort(), unidentified };
  if (same(readSpending(dir).selections[name], data)) return;
  appendSpending(dir, { type: 'selection', data });
}

const total = () => ({ attempts: 0, settled: 0, unknown: 0, usd: 0n, currencies: {}, estimatedUSD: 0n, estimates: 0, planValueUSD: 0n });
const publicTotal = t => ({ ...t, usd: amount(t.usd), estimatedUSD: amount(t.estimatedUSD), planValueUSD: amount(t.planValueUSD), currencies: Object.fromEntries(Object.entries(t.currencies).map(([key, value]) => [key, amount(value)])) });
export function spendingReport(dir) {
  const state = readSpending(dir);
  const used = new Set(Object.values(state.selections).flatMap(x => x.projectIds));
  const all = total(), clips = total(), usedClips = total(), models = {};
  // A recovered/imported project can have several receipts. Its bill counts once.
  const unique = new Map();
  for (const attempt of Object.values(state.attempts).sort((a, b) => state.attemptOrder[a.id] - state.attemptOrder[b.id])) {
    const key = attempt.projectId ? `${attempt.provider}:${attempt.projectId}` : attempt.id;
    const previous = unique.get(key);
    unique.set(key, { ...previous, ...attempt, charge: attempt.charge ?? previous?.charge, aliases: [...(previous?.aliases ?? []), attempt.id] });
  }
  const add = (t, a) => {
    t.attempts++;
    if (!a.charge) { t.unknown++; if (a.estimate?.usd != null) { t.estimatedUSD += decimal(a.estimate.usd); t.estimates++; } return; }
    t.settled++;
    if (a.planValueUSD != null) t.planValueUSD += decimal(a.planValueUSD);
    const refunds = Object.values(state.refunds).filter(r => a.aliases.includes(r.attemptId));
    const usd = decimal(a.charge.usd) - refunds.reduce((n, r) => n + decimal(r.usd), 0n);
    const tokens = decimal(a.charge.tokens) - refunds.reduce((n, r) => n + decimal(r.tokens), 0n);
    if (usd < 0n || tokens < 0n) throw new Error(`Refund exceeds the recorded charge for ${a.projectId ?? a.id}; reconcile its receipts`);
    t.usd += usd;
    const key = `${a.provider}:${a.charge.currency}`;
    t.currencies[key] = (t.currencies[key] ?? 0n) + tokens;
  };
  for (const a of unique.values()) {
    add(all, a);
    const key = `${a.provider}:${a.model ?? 'unknown'}`;
    add(models[key] ??= total(), a);
    if (a.kind === 'video') { add(clips, a); if (used.has(`${a.provider}:${a.projectId}`)) add(usedClips, a); }
  }
  const funding = { cashUSD: 0n, creditValueUSD: 0n, currencies: {}, creditsWithoutUSDValue: 0, receipts: Object.keys(state.funding).length };
  for (const f of Object.values(state.funding)) {
    funding.cashUSD += decimal(f.cashUSD);
    if (f.kind === 'credit') { if (f.creditValueUSD == null) funding.creditsWithoutUSDValue++; else funding.creditValueUSD += decimal(f.creditValueUSD); }
    const key = `${f.kind}:${f.provider}:${f.currency}`;
    funding.currencies[key] = (funding.currencies[key] ?? 0n) + decimal(f.amount);
  }
  const knownProjects = new Set([...unique.values()].filter(a => a.projectId).map(a => `${a.provider}:${a.projectId}`));
  return { schema: 1, file: spendingFile(dir), coverage: state.coverage, project: publicTotal(all), clips: { used: publicTotal(usedClips), allAttempts: publicTotal(clips) }, models: Object.fromEntries(Object.entries(models).map(([key, t]) => [key, publicTotal(t)])), funding: { ...funding, cashUSD: amount(funding.cashUSD), creditValueUSD: amount(funding.creditValueUSD), currencies: Object.fromEntries(Object.entries(funding.currencies).map(([key, value]) => [key, amount(value)])) }, selectedProjectsWithoutReceipts: [...used].filter(id => !knownProjects.has(id)), selectedClipsWithoutProjectIds: Object.values(state.selections).reduce((n, s) => n + (s.unidentified ?? 0), 0), selections: state.selections };
}

export const clientSpending = client => clients.get(client);

export function recordCoverage(dir, data) {
  if (!data.historicalCoverage?.trim() || data.historicalCoverage.length > 2000) throw new Error('Coverage needs a concise verified historical scope');
  const trackedSince = data.trackedSince ?? readSpending(dir).coverage?.trackedSince ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(trackedSince))) throw new Error('Coverage trackedSince must be a date');
  appendSpending(dir, { type: 'coverage', data: { trackedSince, historicalCoverage: data.historicalCoverage } });
}

export function importSpendingJournals(dir) {
  const prior = readSpending(dir);
  const imported = legacyAttempts(dir);
  for (const entry of imported) {
    if (entry.projectId) recordAttempt(dir, entry);
    else if (!prior.attempts[entry.id]) appendSpending(dir, { type: 'attempt', data: entry });
  }
  const coverage = { trackedSince: prior.coverage?.trackedSince ?? new Date().toISOString(), historicalCoverage: 'Available Kit media receipts imported locally. Missing charges, earlier LLM calls, removed receipts and funding still need reconciliation.', importedAt: new Date().toISOString() };
  appendSpending(dir, { type: 'coverage', data: coverage });
  return imported.length;
}

/** Import an external tool's sanitized receipt. A quote stays an estimate. */
export function recordAttempt(dir, data) {
  if (!data.provider?.trim() || !data.projectId?.trim() || !['video', 'image', 'audio', 'llm', '3d', 'other'].includes(data.kind)) throw new Error('Attempt needs provider, projectId and kind');
  const entry = { id: data.id ?? `${data.provider}:${data.projectId}`, provider: data.provider, projectId: data.projectId, kind: data.kind, model: data.model ?? 'unknown', status: data.status ?? 'unknown', currency: data.currency ?? 'spark' };
  if (data.charge != null) entry.charge = { usd: cleanAmount(data.charge.usd), tokens: cleanAmount(data.charge.tokens), currency: data.charge.currency ?? entry.currency };
  if (data.estimate != null) entry.estimate = { usd: cleanAmount(data.estimate.usd) };
  if (data.planValueUSD != null) {
    if (entry.charge?.usd !== '0' || entry.charge?.tokens !== '0') throw new Error('Plan value needs a confirmed zero-charge subscription receipt');
    entry.planValueUSD = cleanAmount(data.planValueUSD);
  }
  if (data.correctionReference?.trim()) entry.correctionReference = data.correctionReference;
  const state = readSpending(dir);
  const confirmed = Object.values(state.attempts).filter(a => a.provider === entry.provider && a.projectId === entry.projectId && a.charge).sort((a, b) => state.attemptOrder[a.id] - state.attemptOrder[b.id]).at(-1);
  if (entry.charge && confirmed && !same(entry.charge, confirmed.charge) && !entry.correctionReference) throw new Error(`Conflicting confirmed charge for ${entry.provider}:${entry.projectId}; a documented adjustment needs correctionReference`);
  const previous = state.attempts[entry.id];
  if (same(previous, entry)) return previous;
  appendSpending(dir, { type: 'attempt', data: entry });
  return entry;
}

/** Instrument existing SDK calls. No prompts, credentials or balance snapshots. */
export function trackSpending(client, dir, { warn = text => console.error(text) } = {}) {
  if (clients.has(client)) return clients.get(client);
  let prior = readSpending(dir); // A damaged journal stops before another paid call.
  if (!prior.coverage) { importSpendingJournals(dir); prior = readSpending(dir); }
  const attempts = new Map(Object.values(prior.attempts).map(a => [a.id, a]));
  const records = new Map();
  const ledger = {
    dir,
    begin(data) {
      const a = { id: randomUUID(), provider: 'sogni', status: 'submitting', startedAt: new Date().toISOString(), ...data };
      appendSpending(dir, { type: 'attempt', data: a });
      attempts.set(a.id, a);
      return a;
    },
    update(a, data) {
      try { appendSpending(dir, { type: 'attempt', data: { id: a.id, ...data } }); }
      catch (error) { error.spending = true; throw error; }
      Object.assign(a, data);
    },
    takeRecord(id) { const record = records.get(id); records.delete(id); return record; },
    async readActual(id) {
      const a = [...attempts.values()].find(x => x.projectId === id);
      if (!a) throw new Error(`No spending receipt for ${id}; import its attempt first`);
      if (a.charge) return;
      try {
        await projects.get(id);
        if (!a.charge) throw new Error('Charge is not available yet');
      }
      catch (error) { ledger.update(a, { reconciliationNeeded: true, errorCode: error?.status ?? null }); warn(`Spending: ${id}'s charge is unconfirmed; generation is preserved. node world spend lists unresolved amounts.`); }
    },
    actual(a, record) {
      const cost = record.costActual;
      const payment = record.paymentModel ?? record.completedWorkerJobs?.[0]?.paymentModel ?? a.billingMode;
      const subscription = payment === 'subscription';
      let charge, planValue;
      try {
        charge = subscription ? { usd: '0', tokens: '0', currency: a.currency } : cost?.costInUSD != null && cost?.costInToken != null ? { usd: cleanAmount(cost.costInUSD), tokens: cleanAmount(cost.costInToken), currency: a.currency } : null;
        if (subscription && cost?.costInUSD != null) planValue = cleanAmount(cost.costInUSD);
      } catch {
        // A bad cost field must not retry a successful paid generation.
        ledger.update(a, { status: record.status, reconciliationNeeded: true });
        warn(`Spending: ${a.projectId ?? a.id} returned an invalid cost; its charge needs reconciliation.`);
        return;
      }
      ledger.update(a, { status: record.status, ...(charge ? { charge, reconciliationNeeded: false } : { reconciliationNeeded: true }), ...(planValue != null ? { planValueUSD: planValue } : {}) });
    },
  };
  clients.set(client, ledger);
  const projects = client.projects;
  const get = projects.get?.bind(projects);
  if (get) projects.get = async (id, ...args) => {
    const record = await get(id, ...args);
    const a = [...attempts.values()].find(x => x.projectId === id);
    if (a && ['completed', 'errored', 'failed', 'cancelled', 'canceled'].includes(record.status)) {
      ledger.actual(a, record); records.set(id, record);
    }
    return record;
  };
  const create = projects.create.bind(projects);
  projects.create = async (...args) => {
    const request = args[0];
    const a = ledger.begin({ kind: request.type ?? 'image', model: request.modelId, currency: request.tokenType ?? 'spark', billingMode: request.billingMode ?? 'auto' });
    let project;
    try { project = await create(...args); }
    catch (error) { ledger.update(a, { status: 'submission-uncertain', errorCode: error?.code ?? null }); throw error; }
    ledger.update(a, { projectId: project.id, status: 'submitted' });
    const wait = project.waitForCompletion?.bind(project);
    if (wait) project.waitForCompletion = async (...waitArgs) => {
      try {
        const output = await wait(...waitArgs);
        ledger.update(a, { status: 'completed' });
        if (get) await ledger.readActual(project.id);
        return output;
      } catch (error) {
        ledger.update(a, { status: project.finished ? project.status : 'outcome-unknown', errorCode: error?.code ?? null });
        throw error;
      }
    };
    return project;
  };
  const completions = client.chat?.completions;
  if (completions?.create) {
    const createChat = completions.create.bind(completions);
    completions.create = async (...args) => {
      const request = args[0];
      const a = ledger.begin({ kind: 'llm', model: request.model, currency: request.tokenType ?? 'spark', billingMode: request.billingMode ?? 'auto' });
      let stream;
      try { stream = await createChat(...args); }
      catch (error) { ledger.update(a, { status: 'submission-uncertain', errorCode: error?.code ?? null }); throw error; }
      if (stream.jobID) ledger.update(a, { projectId: stream.jobID, status: 'submitted' });
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        const iterator = iterate();
        let completed = false;
        try {
          for (;;) { const chunk = await iterator.next(); if (chunk.done) break; yield chunk.value; }
          completed = true;
          const cost = stream.finalResult?.cost;
          ledger.actual(a, { status: 'completed', costActual: cost, paymentModel: a.billingMode });
        } catch (error) { ledger.update(a, { status: 'outcome-unknown', errorCode: error?.code ?? null }); throw error; }
        finally {
          if (!completed) { await iterator.return?.(); ledger.update(a, { status: 'outcome-unknown' }); }
        }
      };
      return stream;
    };
  }
  return ledger;
}
