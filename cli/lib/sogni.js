// Talking to Sogni: sign in, decide who pays, quote, submit, wait, download.
// The render discipline (journal before paying, never resubmit an uncertain
// job, verify the bytes you got) is the one three published worlds were built with.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SogniClient } from '@sogni-ai/sogni-client';
import { billingPreference, sogniCredentials } from './env.js';

export const LINKS = Object.freeze({
  apiKey: 'https://dashboard.sogni.ai/api-key',
  plans: 'https://docs.sogni.ai/pricing/unlimited-plan-details/',
  subscribe: 'https://app.sogni.ai/wallet',
  usage: 'https://app.sogni.ai/usage',
});

export const UNLIMITED_TIERS = ['unlimited', 'unlimited_pro'];
export const TIER_NAMES = { unlimited: 'Unlimited', unlimited_pro: 'Unlimited Pro' };

/** Refusals worth explaining in plain words; anything else reports its code. */
export const REFUSALS = {
  4087: 'your Unlimited plan’s daily fair-use capacity on the Fast network is used up. It resets on your plan’s daily schedule (see https://app.sogni.ai/usage); Premium Spark keeps the Fast lane open meanwhile',
  4089: 'your Unlimited plan’s monthly fair-use capacity on the Fast network is used up. It resets on your billing date; Premium Spark keeps the Fast lane open meanwhile',
  4088: 'this model needs Premium Spark, an Unlimited plan or SOGNI; free Spark cannot pay for it',
  4100: 'no worker serving this model can pin keyframes yet; render without keyframes or try again later',
};

export function sdkVersion() {
  try {
    const require = createRequire(import.meta.url);
    return JSON.parse(readFileSync(require.resolve('@sogni-ai/sogni-client/package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** An error safe to print: its message and status only, with the key scrubbed out. */
export function safeError(error, prefix) {
  const key = sogniCredentials()?.apiKey;
  let message = String(error?.message ?? error ?? 'unknown error').slice(0, 300);
  if (key) message = message.split(key).join('<api key>');
  const status = typeof error?.status === 'number' ? ` (HTTP ${error.status})` : '';
  const wrapped = new Error(prefix ? `${prefix}: ${message}${status}` : `${message}${status}`);
  if (typeof error?.status === 'number') wrapped.status = error.status;
  if (Number.isFinite(error?.code)) wrapped.code = error.code;
  return wrapped;
}

/**
 * Sign in and decide billing. Billing is SOGNI_BILLING_MODE when set;
 * otherwise an active Unlimited plan pays ("subscription"), else tokens.
 */
export async function connect({ appId } = {}) {
  const credentials = sogniCredentials();
  if (!credentials) throw new Error(`No Sogni API key found. Run: node world setup   (get a key at ${LINKS.apiKey})`);
  // Recorded in each journal, so a later run can tell which app instance holds its projects.
  const clientAppId = appId ?? `sogni-worlds-kit-${randomUUID()}`;
  let client;
  try {
    client = await SogniClient.createInstance({
      appId: clientAppId,
      appSource: 'sogni-worlds-kit',
      network: 'fast',
      logLevel: 'error',
      ...(credentials.apiKey ? { apiKey: credentials.apiKey, authType: 'apiKey' } : {}),
    });
    if (!credentials.apiKey) await client.account.login(credentials.username, credentials.password);
    // Check the key over REST first: a rejected key answers at once here, instead
    // of surfacing as a 15-second wait for models on a socket that never signs in.
    try {
      await client.account.me();
    } catch (error) {
      // A rejected key can surface from me() without a status ("The account
      // changed…"); a second REST call answers 401 for it.
      let status = error?.status;
      if (!status) {
        try { await client.account.refreshBalance(); } catch (second) { status = second?.status; }
      }
      if ([401, 403].includes(status)) {
        throw new Error(credentials.apiKey
          ? `Sogni rejected this API key (from ${credentials.source}). Check it at ${LINKS.apiKey}, then: node world setup`
          : 'Sogni rejected this username and password');
      }
      throw error;
    }
    // The first model list arrives over the signed-in socket; wait for it before submitting anything.
    await client.projects.waitForModels?.(15_000);
  } catch (error) {
    close(client);
    if (/^Sogni rejected/.test(error?.message ?? '')) throw error;
    throw safeError(error, 'Could not sign in to Sogni');
  }
  let subscription = null;
  try { subscription = await client.account.refreshSubscription(); } catch { /* no plan information: treated as no plan */ }
  const tier = subscription?.active && UNLIMITED_TIERS.includes(subscription.tier) ? subscription.tier : null;
  const preference = billingPreference();
  const mode = preference.mode ?? (tier ? 'subscription' : 'tokens');
  if (mode === 'subscription' && !tier) {
    close(client);
    throw new Error(`SOGNI_BILLING_MODE is subscription, but this account has no active Unlimited plan. Subscribe at ${LINKS.subscribe} or set SOGNI_BILLING_MODE=tokens`);
  }
  return {
    client,
    appId: clientAppId,
    username: client.account.currentAccount.username ?? null,
    credentialSource: credentials.source,
    subscription,
    tier,
    billing: { mode, tokenType: preference.tokenType, tier, why: preference.mode ? 'SOGNI_BILLING_MODE' : tier ? 'active Unlimited plan' : 'no Unlimited plan on this account' },
    close: () => close(client),
  };
}

function close(client) {
  try { client?.dispose?.(); } catch { /* already closed */ }
}

export function describeBilling({ mode, tokenType, tier, why }) {
  const token = tokenType === 'sogni' ? 'SOGNI' : 'Spark';
  if (mode === 'subscription') return `${TIER_NAMES[tier] ?? 'Unlimited'} plan pays (nothing is taken from your ${token} balance) — ${why}`;
  if (mode === 'auto') return `your plan pays what it covers, ${token} pays the rest — ${why}`;
  return `${token} tokens pay — ${why}`;
}

/** Collect admission refusals, which can arrive before a project exists on the server. */
export function watchRefusals(client) {
  const refusals = new Map();
  let creating = false;
  const onProject = event => {
    if (event?.type !== 'error') return;
    const key = typeof event.projectId === 'string' ? event.projectId : creating ? 'unassigned' : null;
    if (!key) return;
    const error = event.error ?? {};
    // Never keep transport objects, headers or raw server text: code and a short message only.
    refusals.set(key, { code: Number.isFinite(error.code) ? error.code : null, message: String(error.message ?? '').slice(0, 200) });
  };
  client.projects.on?.('project', onProject);
  return {
    get: projectId => refusals.get(projectId) ?? null,
    /** Run `create` with unassigned refusals attributed to it. Creates must not overlap. */
    async creating(fn) {
      creating = true;
      refusals.delete('unassigned');
      try {
        return await fn();
      } finally {
        creating = false;
      }
    },
    unassigned: () => refusals.get('unassigned') ?? null,
    stop: () => client.projects.off?.('project', onProject),
  };
}

export function refusalMessage(failure) {
  if (!failure) return 'the job failed';
  return REFUSALS[failure.code] ? `refused (${failure.code}): ${REFUSALS[failure.code]}` : `refused${failure.code ? ` (${failure.code})` : ''}${failure.message ? `: ${failure.message}` : ''}`;
}

/**
 * Whether a failed create() is a known outcome: Sogni refused it (a refusal
 * event, a server error code, or an HTTP 4xx answer). A dropped connection or a
 * 5xx is not: the job may exist, so its receipt stays reserved and it is never sent twice.
 */
export const refusedForSure = (error, refusal) => Boolean(refusal)
  || Number.isFinite(error?.code)
  || (Number.isFinite(error?.status) && error.status >= 400 && error.status < 500);

export class RefusedError extends Error {
  constructor(failure) {
    super(refusalMessage(failure));
    this.failure = failure;
  }
}

/**
 * Requests to api.sogni.ai count against a per-IP budget that the artist's own
 * browser shares, so nothing here polls: projects are followed over the SDK's
 * socket. The few one-off REST reads that remain wait 30 s after a 429,
 * doubling to 5 min, instead of retrying through it (2026-10-01: status polling
 * that retried through 429s got the owner's IP blocked out of his account).
 */
const RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
export const rateLimitDelay = rateLimited => Math.min(MAX_RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS * 2 ** (Math.max(1, rateLimited) - 1));
const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const SAFE_CONTENT_WITHHELD = 'the safe-content filter withheld the result (set contentFilter: off in world.yaml if this is a false positive)';

/**
 * Follow a tracked project to its end over the socket: no requests while it
 * waits. Resolves with its result URLs; throws RefusedError when it fails and a
 * plain Error on timeout (unknown outcome: it keeps rendering, never resubmit).
 */
export async function settleProject(project, { refusals, timeoutMs = 120 * 60_000, onStatus } = {}) {
  let last;
  const say = () => {
    const status = `${project.status}${project.waitingReason?.message ? ` (${project.waitingReason.message})` : ''}`;
    if (status !== last) {
      last = status;
      onStatus?.(status);
    }
  };
  let timer;
  project.on?.('updated', say);
  say();
  try {
    return await Promise.race([
      project.waitForCompletion().catch(error => {
        const refused = refusals?.get(project.id);
        throw new RefusedError(refused ?? { code: Number.isFinite(error?.code) ? error.code : null, message: `project failed${error?.message ? `: ${String(error.message).slice(0, 200)}` : ''}` });
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Still not finished after ${Math.round(timeoutMs / 60000)} minutes. It keeps rendering on Sogni; run the same command again to pick it up.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    project.off?.('updated', say);
  }
}

/**
 * One REST read of a finished project, retried only where that is the right
 * answer: a 404 a few times (the socket stores a project a moment after it
 * finishes; a failed one is never stored), a 429 after a growing wait. Resolves
 * null when there is still nothing after `attempts` misses.
 */
export async function readFinished(read, { attempts = 6, delayMs = 5000, sleep = sleepFor } = {}) {
  let misses = 0;
  let rateLimited = 0;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (error?.status === 429) {
        rateLimited += 1;
        if (rateLimited > 5) throw safeError(error, 'Sogni kept answering "too many requests"; run the same command again later');
        await sleep(rateLimitDelay(rateLimited));
        continue;
      }
      if (error?.status && error.status < 500 && error.status !== 404) throw safeError(error, 'Could not read the project');
      misses += 1;
      if (misses >= attempts) return null;
      await sleep(delayMs);
    }
  }
}

/** The stored record of a finished project: the result's hash and filter flags. */
export const fetchStoredRecord = (client, projectId, options) => readFinished(() => client.projects.get(projectId), options);

/**
 * Take back a project an earlier run submitted. A project still rendering is
 * held by the app instance that submitted it; signing in as that app hands it to
 * this process, live, through the SDK's recovery (projects.sync). The earlier
 * run must be gone: two connections with one app id displace each other.
 * Returns { project, session } for a live one, or { finished: true } when the
 * socket no longer holds it (it finished or failed while nobody listened).
 */
export async function recoverProject(client, projectId, { ownerPid, connectAs = appId => connect({ appId }) } = {}) {
  const elsewhere = await client.projects.listProjectsElsewhere();
  const live = elsewhere.find(project => project.id === projectId);
  if (!live) return { finished: true };
  if (Number.isInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new Error(`Project ${projectId} is still being followed by another run (pid ${ownerPid}); let that run finish`);
  }
  const session = await connectAs(live.appId);
  try {
    await session.client.projects.sync('resume');
    const project = session.client.projects.trackedProjects.find(p => p.id === projectId);
    if (project) return { project, session };
  } catch (error) {
    session.close();
    throw safeError(error, 'Could not take the project back from Sogni');
  }
  session.close();
  return { finished: true };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Wait for a project and return its stored record (what downloadResult reads).
 * Pass `project` for one this client created, or `projectId` (and the `ownerPid`
 * its journal recorded) for one an earlier run submitted. Throws RefusedError
 * for a failure (a known outcome) and a plain Error when the outcome is unknown.
 */
export async function waitForProject(client, { project, projectId, ownerPid }, { refusals, timeoutMs, onStatus, sleep = sleepFor, connectAs } = {}) {
  const id = project?.id ?? projectId;
  let session = null;
  try {
    let tracked = project;
    if (!tracked) {
      const recovered = await recoverProject(client, id, { ownerPid, connectAs });
      tracked = recovered.project ?? null;
      session = recovered.session ?? null;
    }
    if (tracked) await settleProject(tracked, { refusals, timeoutMs, onStatus });
    const record = await fetchStoredRecord(client, id, { sleep });
    if (!record) {
      throw new Error(tracked
        ? `Project ${id} finished but Sogni has no stored result for it yet; run the same command again in a minute`
        : `Project ${id} is no longer rendering and Sogni stored no result for it, so it most likely failed. Check https://app.sogni.ai (project history)`);
    }
    if (['errored', 'failed', 'cancelled', 'canceled'].includes(record.status)) {
      const job = record.workerJobs?.find?.(j => j.error) ?? record.completedWorkerJobs?.[0];
      throw new RefusedError({ code: Number.isFinite(record.error?.code) ? record.error.code : Number.isFinite(job?.error?.code) ? job.error.code : null, message: `project ${record.status}` });
    }
    if (record.status !== 'completed') throw new Error(`Project ${id} is ${record.status}; run the same command again to pick it up`);
    // Same rule as the SDK's own results: withheld only when the filter fired and
    // no advisory label says the media was delivered anyway.
    if (record.completedWorkerJobs?.some(j => j.triggeredNSFWFilter === true && j.nsfwDetected !== true)) {
      throw new RefusedError({ code: null, message: SAFE_CONTENT_WITHHELD });
    }
    return record;
  } finally {
    session?.close();
  }
}

/** Download a finished video (or other media) and check it against the server's own hash. */
export async function downloadResult(client, result, { contentType = 'video/mp4', maxBytes = 256 * 1024 * 1024 } = {}) {
  if (result.completedWorkerJobs?.length !== 1) throw new Error('The project did not return exactly one result');
  const job = result.completedWorkerJobs[0];
  if (!job.imgID) throw new Error('The finished job has no result file');
  const url = contentType.startsWith('image/')
    ? await client.projects.downloadUrl({ jobId: result.id, imageId: job.imgID, type: 'complete' })
    : await client.projects.mediaDownloadUrl({ jobId: result.id, id: job.imgID, type: 'complete', contentType });
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Downloading the result failed (HTTP ${response.status}); run the command again to retry the download`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('The result is larger than expected');
  return { bytes, job };
}

/** Quote one film before it is submitted. */
export async function quoteFilm(client, { model, width, height, frames, keyframes = 0, tokenType, billingMode }) {
  const quote = await client.projects.estimateVideoCost({
    model, tokenType, width, height, duration: frames / 24, fps: 24, steps: 4, numberOfMedia: 1,
    referenceImageCount: 2, keyframeCount: keyframes, network: 'fast', billingMode,
  });
  return {
    spark: Number(quote.spark),
    sogni: Number(quote.sogni),
    usd: Number(quote.usd),
    renderSeconds: quote.estimatedRenderSeconds ?? null,
    dailyFairUsePct: quote.dailyFairUsePct ?? null,
  };
}
