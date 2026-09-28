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
  let client;
  try {
    client = await SogniClient.createInstance({
      appId: appId ?? `sogni-worlds-kit-${randomUUID()}`,
      appSource: 'sogni-worlds-kit',
      network: 'fast',
      logLevel: 'error',
      ...(credentials.apiKey ? { apiKey: credentials.apiKey, authType: 'apiKey' } : {}),
    });
    if (!credentials.apiKey) await client.account.login(credentials.username, credentials.password);
    // The first model list arrives over the signed-in socket; wait for it before submitting anything.
    await client.projects.waitForModels?.(15_000);
    await client.account.me();
  } catch (error) {
    close(client);
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

export class RefusedError extends Error {
  constructor(failure) {
    super(refusalMessage(failure));
    this.failure = failure;
  }
}

/**
 * Poll a submitted project until it completes. Returns the raw project.
 * Throws RefusedError for a recorded refusal or failure (a known outcome), or
 * a plain Error on timeout (unknown outcome: resume later, never resubmit).
 */
export async function waitForProject(client, projectId, { refusals, timeoutMs = 120 * 60_000, onStatus, kind = 'video' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    const refused = refusals?.get(projectId);
    if (refused) throw new RefusedError(refused);
    // The live lookup reports a project while it is queued or rendering and
    // when it fails. The stored record (projects.get) answers 404 until the
    // project completes, and forever for a failed one, so a wait built only on
    // it would hang on a failure. Use the live lookup for the state and the
    // stored record for the finished project's receipt.
    let live = null;
    try {
      live = await client.projects.getResult(projectId, { kind });
    } catch (error) {
      if (error?.status && error.status < 500 && ![404, 429].includes(error.status)) throw safeError(error, 'Could not read the project');
    }
    const status = live ? `${live.status}${live.waitingReason?.message ? ` (${live.waitingReason.message})` : ''}` : null;
    if (status && status !== last) {
      last = status;
      onStatus?.(status);
    }
    if (live?.finished && live.status !== 'completed') {
      const reason = live.jobs?.find(j => j.reason)?.reason;
      throw new RefusedError({ code: null, message: `project ${live.status}${reason ? `: ${reason}` : ''}` });
    }
    if (live?.status === 'completed' && live.jobs?.some(j => j.urlUnavailable === 'sensitiveContent')) {
      throw new RefusedError({ code: null, message: 'the safe-content filter withheld the result (set contentFilter: off in world.yaml if this is a false positive)' });
    }
    let result;
    try {
      result = await client.projects.get(projectId);
    } catch (error) {
      if (error?.status && error.status < 500 && ![404, 429].includes(error.status)) throw safeError(error, 'Could not read the project');
    }
    if (result?.status === 'completed') return result;
    if (['errored', 'failed', 'cancelled', 'canceled'].includes(result?.status)) {
      const job = result.workerJobs?.find?.(j => j.error) ?? result.completedWorkerJobs?.[0];
      throw new RefusedError({ code: Number.isFinite(result.error?.code) ? result.error.code : Number.isFinite(job?.error?.code) ? job.error.code : null, message: `project ${result.status}` });
    }
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error(`Still not finished after ${Math.round(timeoutMs / 60000)} minutes. It keeps rendering on Sogni; run the same command again to pick it up.`);
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
