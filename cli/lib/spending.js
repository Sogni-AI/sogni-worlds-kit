// Project lifetime accounting. One append-only local journal, written before
// submission; reports never contact Sogni or search render/history folders.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { legacyAttempts } from './spending-import.js';
import { spendingTransaction } from './spending-lock.js';

const clients = new WeakMap();
// Server BigNumber strings include fractional tails beyond 18 places. Preserve
// those exact values; never round a settled bill into a different amount.
const PRECISION = 100;
const SCALE = 10n ** BigInt(PRECISION);
const decimal = value => {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || text.length > 512) throw new Error(`Invalid nonnegative accounting amount: ${text}`);
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 100) throw new Error('Accounting amount is outside the supported range');
  const power = PRECISION + exponent - fraction.length;
  const digits = BigInt(match[1] + fraction);
  let scaled;
  if (power >= 0) scaled = digits * 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    if (digits % divisor) throw new Error(`Accounting amount needs more than ${PRECISION} decimal places`);
    scaled = digits / divisor;
  }
  if (scaled >= SCALE * 10n ** 100n) throw new Error('Accounting amount is outside the supported range');
  return scaled;
};
const amount = value => {
  const sign = value < 0n ? '-' : '';
  const positive = value < 0n ? -value : value;
  const fraction = String(positive % SCALE).padStart(PRECISION, '0').replace(/0+$/, '');
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
  return spendingTransaction(dir, () => appendEvent(dir, entry));
}

function appendEvent(dir, entry) {
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
  if (!existsSync(spendingFile(dir))) return readLedger(dir);
  return spendingTransaction(dir, () => readLedger(dir));
}

const projectKey = a => a.projectId ? JSON.stringify([a.provider, a.projectId]) : a.id;
const correctionKey = a => JSON.stringify([a.provider, a.projectId, a.correctionReference]);
function readLedger(dir) {
  const state = { attempts: Object.create(null), attemptOrder: Object.create(null), chargeOrder: Object.create(null), corrections: Object.create(null), funding: Object.create(null), selections: Object.create(null), refunds: Object.create(null), coverage: null };
  let order = 0;
  for (const event of events(dir)) {
    if (event.schema !== 1) throw new Error('Unsupported spending ledger schema');
    const { type, data } = event;
    if (type === 'attempt') {
      const previous = state.attempts[data.id];
      assertIdentity(previous, data);
      let replay = false;
      if (data.charge && data.correctionReference) {
        const a = { ...previous, ...data }, key = correctionKey(a);
        const adjustment = { charge: data.charge, planValueUSD: data.planValueUSD ?? null, attemptId: data.id };
        const prior = state.corrections[key];
        if (prior && (!same(prior.charge, adjustment.charge) || (data.planValueUSD != null && prior.planValueUSD != null && prior.planValueUSD !== data.planValueUSD))) throw new Error('Conflicting correction reference in spending ledger');
        replay = Boolean(prior);
        state.corrections[key] ??= adjustment;
      }
      const metadata = { ...data };
      if (replay) { delete metadata.charge; delete metadata.planValueUSD; }
      if (data.planValueFor) {
        const adjustment = state.corrections[correctionKey({ ...previous, correctionReference: data.planValueFor })];
        if (!adjustment) throw new Error('Plan value refers to an unknown correction');
        if (adjustment.planValueUSD != null && adjustment.planValueUSD !== data.planValueUSD) throw new Error('Conflicting correction plan value');
        adjustment.planValueUSD = data.planValueUSD;
        // Enrich that settlement only; a later correction keeps its own value.
        if (previous.settlementReference !== data.planValueFor) delete metadata.planValueUSD;
      }
      let planValue = data.planValueUSD ?? null;
      if (data.charge && !replay && planValue == null && data.charge.usd === '0' && data.charge.tokens === '0') {
        const current = canonicalAttempts(state).get(projectKey({ ...previous, ...data }));
        if (same(current?.charge, data.charge)) planValue = current.planValueUSD ?? null;
      }
      state.attempts[data.id] = { ...previous, ...metadata };
      state.attemptOrder[data.id] = order++;
      if (data.charge && !replay) {
        state.chargeOrder[data.id] = order;
        state.attempts[data.id].planValueUSD = planValue;
        state.attempts[data.id].settlementReference = data.correctionReference ?? null;
        if (data.correctionReference) state.corrections[correctionKey(state.attempts[data.id])].planValueUSD = planValue;
      }
    }
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

function assertIdentity(previous, data) {
  if (previous && ['provider', 'projectId'].some(key => previous[key] != null && data[key] != null && previous[key] !== data[key])) throw new Error(`Attempt ID ${data.id} already belongs to a different provider/project`);
}

function canonicalAttempts(state) {
  const unique = new Map();
  for (const a of Object.values(state.attempts).sort((a, b) => state.attemptOrder[a.id] - state.attemptOrder[b.id])) {
    const key = projectKey(a), previous = unique.get(key);
    const newerCharge = a.charge && (state.chargeOrder[a.id] ?? -1) > (previous?.chargeOrder ?? -1);
    unique.set(key, { ...previous, ...a, model: a.model && a.model !== 'unknown' ? a.model : previous?.model ?? a.model,
      charge: newerCharge ? a.charge : previous?.charge, planValueUSD: newerCharge ? a.planValueUSD : previous?.planValueUSD,
      chargeOrder: newerCharge ? state.chargeOrder[a.id] : previous?.chargeOrder, aliases: [...(previous?.aliases ?? []), a.id] });
  }
  return unique;
}

function validateRefunds(state, attempt, charge, extra = []) {
  const refunds = [...Object.values(state.refunds).filter(r => attempt.aliases.includes(r.attemptId)), ...extra];
  if (refunds.some(r => r.currency !== charge.currency)
    || refunds.reduce((n, r) => n + decimal(r.usd), 0n) > decimal(charge.usd)
    || refunds.reduce((n, r) => n + decimal(r.tokens), 0n) > decimal(charge.tokens)) throw new Error('Refund exceeds or conflicts with the current recorded charge');
}

// Used by imports and SDK updates under the same lock as their append.
function writeAttempt(dir, data) {
  const state = readSpending(dir), previous = state.attempts[data.id];
  assertIdentity(previous, data);
  const merged = { ...previous, ...data };
  if (data.charge) {
    const canonical = canonicalAttempts(state).get(projectKey(merged));
    if (data.correctionReference) {
      const prior = state.corrections[correctionKey(merged)];
      if (prior) {
        if (!same(prior.charge, data.charge) || (data.planValueUSD != null && prior.planValueUSD != null && prior.planValueUSD !== data.planValueUSD)) throw new Error('Correction reference already has different amounts');
        if (data.planValueUSD != null && prior.planValueUSD == null) {
          appendSpending(dir, { type: 'attempt', data: { id: prior.attemptId, planValueFor: data.correctionReference, planValueUSD: data.planValueUSD } });
        }
        return state.attempts[prior.attemptId];
      }
    }
    if (canonical?.charge && !same(canonical.charge, data.charge) && !data.correctionReference) throw new Error(`Conflicting confirmed charge for ${merged.provider}:${merged.projectId}; a documented adjustment needs correctionReference`);
    if (canonical) validateRefunds(state, canonical, data.charge);
  }
  if (same(previous, merged)) return previous;
  appendSpending(dir, { type: 'attempt', data });
  return merged;
}

export function recordFunding(dir, data) {
  return spendingTransaction(dir, () => {
    if (!['credit', 'purchase'].includes(data.kind) || !data.reference?.trim() || !data.provider?.trim() || !data.currency?.trim()) throw new Error('Funding needs kind credit|purchase, provider, currency and a stable receipt reference');
    const entry = { reference: data.reference, kind: data.kind, provider: data.provider, currency: data.currency, amount: cleanAmount(data.amount), cashUSD: cleanAmount(data.cashUSD), creditValueUSD: data.creditValueUSD == null ? null : cleanAmount(data.creditValueUSD) };
    if (entry.kind === 'credit' && entry.cashUSD !== '0') throw new Error('A credit is not a cash purchase; record its actual cash cost as 0');
    const previous = readSpending(dir).funding[entry.reference];
    if (previous) { if (!same(previous, entry)) throw new Error(`Funding receipt ${entry.reference} already has different amounts`); return previous; }
    appendSpending(dir, { type: 'funding', data: entry });
    return entry;
  });
}

export function recordRefund(dir, data) {
  return spendingTransaction(dir, () => {
    if (!data.reference?.trim() || !data.attemptId) throw new Error('A refund needs its receipt reference and attemptId');
    const state = readSpending(dir);
    const alias = state.attempts[data.attemptId];
    const attempt = alias && canonicalAttempts(state).get(projectKey(alias));
    if (!attempt?.charge) throw new Error('Settle the attempt before recording its refund');
    const entry = { reference: data.reference, attemptId: data.attemptId, usd: cleanAmount(data.usd), tokens: cleanAmount(data.tokens), currency: attempt.charge.currency };
    const previous = state.refunds[entry.reference];
    if (previous) { if (!same(previous, entry)) throw new Error('Refund reference already has different amounts'); return previous; }
    validateRefunds(state, attempt, attempt.charge, [entry]);
    appendSpending(dir, { type: 'refund', data: entry });
    return entry;
  });
}

/** A successful build replaces its selection; retired clips stay in lifetime spend. */
export function recordSelection(dir, name, projectIds, { unidentified = 0 } = {}) {
  return spendingTransaction(dir, () => {
    if (!name?.trim() || !Array.isArray(projectIds) || !projectIds.every(x => typeof x === 'string' && x)) throw new Error('Selection needs a name and project IDs');
    if (!Number.isSafeInteger(unidentified) || unidentified < 0) throw new Error('Unidentified clip count must be a nonnegative integer');
    const data = { name, projectIds: [...new Set(projectIds.map(id => id.includes(':') ? id : `sogni:${id}`))].sort(), unidentified };
    if (same(readSpending(dir).selections[name], data)) return;
    appendSpending(dir, { type: 'selection', data });
  });
}

const total = () => ({ attempts: 0, settled: 0, unknown: 0, usd: 0n, currencies: {}, estimatedUSD: 0n, estimates: 0, planValueUSD: 0n });
const publicTotal = t => ({ ...t, usd: amount(t.usd), estimatedUSD: amount(t.estimatedUSD), planValueUSD: amount(t.planValueUSD), currencies: Object.fromEntries(Object.entries(t.currencies).map(([key, value]) => [key, amount(value)])) });
export function spendingReport(dir) {
  const state = readSpending(dir);
  const used = new Set(Object.values(state.selections).flatMap(x => x.projectIds));
  const all = total(), clips = total(), usedClips = total(), models = {};
  // A recovered/imported project can have several receipts. Its bill counts once.
  const unique = canonicalAttempts(state);
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
  return spendingTransaction(dir, () => {
    if (!data.historicalCoverage?.trim() || data.historicalCoverage.length > 2000) throw new Error('Coverage needs a concise verified historical scope');
    const trackedSince = data.trackedSince ?? readSpending(dir).coverage?.trackedSince ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(trackedSince))) throw new Error('Coverage trackedSince must be a date');
    appendSpending(dir, { type: 'coverage', data: { trackedSince, historicalCoverage: data.historicalCoverage } });
  });
}

export function importSpendingJournals(dir) {
  return spendingTransaction(dir, () => {
    const prior = readSpending(dir);
    const imported = legacyAttempts(dir);
    for (const entry of imported) {
      if (entry.projectId) recordAttempt(dir, entry);
      else if (!prior.attempts[entry.id]) appendSpending(dir, { type: 'attempt', data: entry });
    }
    const coverage = { trackedSince: prior.coverage?.trackedSince ?? new Date().toISOString(), historicalCoverage: 'Available Kit media receipts imported locally. Missing charges, earlier LLM calls, removed receipts and funding still need reconciliation.', importedAt: new Date().toISOString() };
    appendSpending(dir, { type: 'coverage', data: coverage });
    return imported.length;
  });
}

/** Import an external tool's sanitized receipt. A quote stays an estimate. */
export function recordAttempt(dir, data) {
  return spendingTransaction(dir, () => {
    if (!data.provider?.trim() || !data.projectId?.trim() || !['video', 'image', 'audio', 'llm', '3d', 'other'].includes(data.kind)) throw new Error('Attempt needs provider, projectId and kind');
    const entry = { id: data.id ?? `${data.provider}:${data.projectId}`, provider: data.provider, projectId: data.projectId, kind: data.kind, model: data.model ?? 'unknown', status: data.status ?? 'unknown', currency: data.currency ?? 'spark' };
    if (data.charge != null) entry.charge = { usd: cleanAmount(data.charge.usd), tokens: cleanAmount(data.charge.tokens), currency: data.charge.currency ?? entry.currency };
    if (data.estimate != null) entry.estimate = { usd: cleanAmount(data.estimate.usd) };
    if (data.planValueUSD != null) {
      if (entry.charge?.usd !== '0' || entry.charge?.tokens !== '0') throw new Error('Plan value needs a confirmed zero-charge subscription receipt');
      entry.planValueUSD = cleanAmount(data.planValueUSD);
    }
    if (data.correctionReference?.trim()) entry.correctionReference = data.correctionReference;
    return writeAttempt(dir, entry);
  });
}

/** Instrument existing SDK calls. No prompts, credentials or balance snapshots. */
export function trackSpending(client, dir, { warn = text => console.error(text) } = {}) {
  if (clients.has(client)) return clients.get(client);
  let prior = readSpending(dir); // A damaged journal stops before another paid call.
  if (!prior.coverage) { importSpendingJournals(dir); prior = readSpending(dir); }
  const attempts = new Map(Object.values(prior.attempts).map(a => [a.id, a]));
  const automaticReads = new Set();
  let blocked = null;
  const ledger = {
    dir,
    begin(data) {
      const a = { id: randomUUID(), provider: 'sogni', status: 'submitting', startedAt: new Date().toISOString(), ...data };
      if (blocked) throw blocked;
      try { spendingTransaction(dir, () => writeAttempt(dir, a)); }
      catch (error) { error.spending = true; throw error; }
      attempts.set(a.id, a);
      return a;
    },
    update(a, data) {
      try { spendingTransaction(dir, () => writeAttempt(dir, { id: a.id, ...data })); }
      catch (error) {
        error.spending = true;
        if (!blocked) warn('Spending: accounting could not be saved. The paid result is preserved; further submissions in this session are blocked. Repair and reconcile the ledger before restarting.');
        blocked = error;
      }
      Object.assign(a, data);
    },
    classify(id, kind) {
      const a = [...attempts.values()].find(x => x.projectId === id);
      if (a) ledger.update(a, { kind });
    },
    async readActual(id, { automatic = false } = {}) {
      const a = [...attempts.values()].find(x => x.projectId === id);
      if (!a) {
        if (automatic) { warn(`Spending: no receipt for ${id}; import it to reconcile this result.`); return; }
        throw new Error(`No spending receipt for ${id}; import its attempt first`);
      }
      if (a.charge) return;
      if (automatic && automaticReads.has(id)) return;
      if (automatic) automaticReads.add(id);
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
      const currency = record.tokenType ?? (payment === 'sogni' ? 'sogni' : ['paid_spark', 'free_spark'].includes(payment) ? 'spark' : a.currency);
      let charge, planValue;
      try {
        charge = subscription ? { usd: '0', tokens: '0', currency } : cost?.costInUSD != null && cost?.costInToken != null ? { usd: cleanAmount(cost.costInUSD), tokens: cleanAmount(cost.costInToken), currency } : null;
        if (subscription && cost?.costInUSD != null) planValue = cleanAmount(cost.costInUSD);
      } catch {
        // A bad cost field must not retry a successful paid generation.
        ledger.update(a, { status: record.status, reconciliationNeeded: true });
        warn(`Spending: ${a.projectId ?? a.id} returned an invalid cost; its charge needs reconciliation.`);
        return;
      }
      ledger.update(a, { status: record.status, currency, ...(charge ? { charge, planValueUSD: planValue ?? null, reconciliationNeeded: false } : { reconciliationNeeded: true }) });
    },
  };
  clients.set(client, ledger);
  const projects = client.projects;
  const get = projects.get?.bind(projects);
  if (get) projects.get = async (id, ...args) => {
    const record = await get(id, ...args);
    const a = [...attempts.values()].find(x => x.projectId === id);
    if (a && ['completed', 'errored', 'failed', 'cancelled', 'canceled'].includes(record.status)) {
      ledger.actual(a, record);
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
        // Videos already read their stored record; audio has one completion
        // lookup in waitForAudio. Only image/mesh callers need an added read.
        if (get && !['video', 'audio'].includes(request.type)) await ledger.readActual(project.id, { automatic: true });
        return output;
      } catch (error) {
        ledger.update(a, { status: project.finished ? project.status : 'outcome-unknown', errorCode: error?.code ?? null });
        if (get && project.finished) await ledger.readActual(project.id, { automatic: true });
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
