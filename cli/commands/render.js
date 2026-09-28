import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { filmsOf, placeById, readPlan } from '../lib/plan.js';
import { assemblePrompt, canvasByName, delivered, FPS, GUIDANCE, MODEL, NETWORK, secondsOf, STEPS } from '../lib/h3.js';
import { lintPlan } from '../lib/lint.js';
import { filmState, listTakes, nextTake, takeFiles } from '../lib/takes.js';
import { readJson, sha256, writeJson } from '../lib/files.js';
import { probe } from '../lib/media.js';
import { connect, describeBilling, downloadResult, quoteFilm, RefusedError, safeError, sdkVersion, waitForProject, watchRefusals } from '../lib/sogni.js';
import { log, usd } from '../lib/log.js';

export const summary = 'Render films (first-and-last-frame MiniMax H3, 2K): a canary first, then the rest; resumable';
export const usage = 'node world render [world] [--canary] [--only <film> ...] [--concurrency n] [--seed n] [--yes] [--dry-run] [--same-direction] [--skip-canary]';

const DEFAULT_CONCURRENCY = { unlimited: 2, unlimited_pro: 4 };

export const contentFilterOff = plan => [false, 'off', 'no', 'false'].includes(plan.contentFilter);
export const canvasOf = plan => {
  if (!plan.canvas) throw new Error('world.yaml has no canvas yet: run `node world ingest` first');
  return canvasByName(String(plan.canvas));
};

/**
 * The films a render run would touch, each with its takes and state. A film
 * that is approved, awaiting a verdict or already rendering is left alone
 * unless named with --only (a rendering take is always resumed).
 */
export function filmsToRender(plan, paths, { only = [], canary = false } = {}) {
  const all = filmsOf(plan).map(film => {
    const takes = listTakes(paths, film.id);
    return { film, takes, state: filmState(takes) };
  });
  if (only.length) {
    const unknown = only.filter(id => !all.some(entry => entry.film.id === id));
    if (unknown.length) throw new Error(`No film named ${unknown.join(', ')}. Films: ${all.map(entry => entry.film.id).join(', ')}`);
    return all.filter(entry => only.includes(entry.film.id));
  }
  if (canary) {
    const crossing = all.find(entry => entry.film.kind === 'crossing');
    const loop = all.find(entry => entry.film.kind === 'loop');
    return [crossing, loop].filter(Boolean);
  }
  return all.filter(entry => ['unrendered', 'failed', 'rejected', 'rendering'].includes(entry.state));
}

/** Everything sent for one new take, except the image bytes. */
export function takeSpec(plan, paths, film, take, { seed } = {}) {
  const canvas = canvasOf(plan);
  const from = placeById(plan, film.from);
  const to = placeById(plan, film.to);
  const file = relative => join(paths.dir, relative);
  const refs = [
    { role: 'first', path: from.still },
    { role: 'last', path: to.still },
    ...(film.keyframes ?? []).map(keyframe => ({ role: 'keyframe', path: keyframe.image, frame: keyframe.frame })),
  ].map(ref => {
    if (!ref.path || !existsSync(file(ref.path))) throw new Error(`${film.id}: ${ref.path ?? 'a still'} is missing`);
    const bytes = readFileSync(file(ref.path));
    return { ...ref, bytes, sha256: sha256(bytes) };
  });
  const prompt = assemblePrompt(film);
  const chosenSeed = seed ?? (take === 1 && Number.isInteger(film.seed) ? film.seed : randomInt(1, 2 ** 31 - 1));
  return {
    canvas,
    refs,
    journal: {
      film: film.id, take, kind: film.kind, from: film.from, to: film.to, object: film.object,
      model: MODEL, width: canvas.width, height: canvas.height, delivered: delivered(canvas),
      frames: film.frames, seconds: Number(secondsOf(film.frames).toFixed(3)), steps: STEPS, fps: FPS, seed: chosenSeed,
      prompt, promptSha256: sha256(prompt),
      references: refs.map(({ role, path, sha256: hash, frame }) => ({ role, path, sha256: hash, ...(frame !== undefined ? { frame } : {}) })),
      contentFilter: contentFilterOff(plan) ? 'off' : 'on',
    },
  };
}

/** The exact projects.create request for a take. */
export function createRequest(spec, billing) {
  const { journal, refs } = spec;
  const keyframes = refs.filter(ref => ref.role === 'keyframe');
  return {
    type: 'video', modelId: journal.model, positivePrompt: journal.prompt,
    network: NETWORK, tokenType: billing.tokenType, billingMode: billing.mode,
    disableNSFWFilter: journal.contentFilter === 'off', numberOfMedia: 1, numberOfPreviews: 0,
    sizePreset: 'custom', width: journal.width, height: journal.height,
    steps: STEPS, guidance: GUIDANCE, seed: journal.seed, frames: journal.frames, fps: FPS,
    referenceImage: refs.find(ref => ref.role === 'first').bytes,
    referenceImageEnd: refs.find(ref => ref.role === 'last').bytes,
    ...(keyframes.length ? { keyframes: keyframes.map(ref => ({ image: ref.bytes, frameIndex: ref.frame })) } : {}),
  };
}

const describeBytes = value => (Buffer.isBuffer(value) ? `<${value.length} bytes, sha256 ${sha256(value).slice(0, 16)}…>` : value);
export const printable = request => JSON.parse(JSON.stringify(request, (key, value) => {
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return describeBytes(Buffer.from(value.data));
  return value;
}));

async function pool(items, size, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

export async function run(argv) {
  const { values, world } = parse(argv, {
    only: { type: 'string', multiple: true }, canary: { type: 'boolean' }, concurrency: { type: 'string' }, seed: { type: 'string' },
    yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'same-direction': { type: 'boolean' }, 'skip-canary': { type: 'boolean' },
  });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const errors = lintPlan(plan, paths).filter(f => f.level === 'error');
  if (errors.length) {
    for (const finding of errors) log.fail(`${finding.where}: ${finding.message}`);
    throw new Error(`world.yaml has ${errors.length} error${errors.length === 1 ? '' : 's'}; nothing was rendered. Fix them (node world lint ${id}) and run again`);
  }

  const selected = filmsToRender(plan, paths, { only: values.only ?? [], canary: values.canary });
  if (!selected.length) {
    log.ok('Nothing to render: every film is approved, awaiting a verdict or rendering');
    log.next(`node world next ${id}`);
    return 0;
  }

  // The canary comes first: one crossing and one loop, judged by a person, before anything else is spent.
  const anyTake = filmsOf(plan).some(film => listTakes(paths, film.id).length);
  if (!values.canary && !values.only && !anyTake && selected.length > 2 && !values['skip-canary']) {
    throw new Error(`Render the canary first — one crossing and one loop — and have them reviewed before the other ${selected.length - 2} film${selected.length - 2 === 1 ? '' : 's'}:\n  node world render ${id} --canary`);
  }

  const work = [];
  for (const entry of selected) {
    const pending = entry.takes.find(t => ['submitting', 'submitted'].includes(t.journal.status));
    if (pending) {
      if (!pending.journal.projectId) {
        throw new Error(`${entry.film.id} take ${pending.take} was being submitted when the last run stopped, so whether Sogni received it is unknown. Look for it at https://app.sogni.ai (project history). If it is not there, delete ${shown(pending.files.journal)} and render again`);
      }
      work.push({ ...entry, resume: pending });
      continue;
    }
    if (['approved', 'unjudged'].includes(entry.state) && !values.only) continue;
    if (entry.state === 'rejected' && !values['same-direction']) {
      const last = entry.takes.filter(t => t.journal.status === 'completed').at(-1);
      if (last && last.journal.prompt === assemblePrompt(entry.film)) {
        throw new Error(`${entry.film.id}: its last take was rejected${last.verdict?.note ? ` ("${last.verdict.note}")` : ''} and the direction has not changed. A new seed rarely fixes a defect: rewrite the film's action or sound for what went wrong, or pass --same-direction`);
      }
    }
    work.push({ ...entry, take: nextTake(entry.takes) });
  }

  const seed = values.seed !== undefined ? Number(values.seed) : undefined;
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) throw new Error('--seed is a whole number');
  const specs = new Map(work.filter(w => !w.resume).map(w => [w.film.id, takeSpec(plan, paths, w.film, w.take, { seed })]));

  const session = await connect();
  const { client, billing } = session;
  const refusals = watchRefusals(client);
  try {
    log.step(`Signed in as ${session.username}. Billing: ${describeBilling(billing)}`);

    // Quote every new take before anything is submitted.
    let totalSpark = 0;
    let totalUsd = 0;
    let fairUse = null;
    for (const w of work.filter(w => !w.resume)) {
      const spec = specs.get(w.film.id);
      const quote = await quoteFilm(client, { model: MODEL, width: spec.canvas.width, height: spec.canvas.height, frames: w.film.frames,
        keyframes: spec.refs.filter(r => r.role === 'keyframe').length, tokenType: billing.tokenType, billingMode: billing.mode });
      spec.journal.quote = quote;
      totalSpark += quote.spark;
      totalUsd += quote.usd;
      fairUse = quote.dailyFairUsePct ?? fairUse;
      log.info(`${w.film.id.padEnd(32)} take ${w.take}  ${w.film.frames} frames (${secondsOf(w.film.frames).toFixed(2)} s)  ${quote.spark.toFixed(0)} Spark (${usd(quote.usd)})`);
    }
    for (const w of work.filter(w => w.resume)) log.info(`${w.film.id.padEnd(32)} take ${w.resume.take}  resuming ${w.resume.journal.projectId}`);
    const newCount = work.filter(w => !w.resume).length;
    if (newCount) {
      const covered = billing.mode === 'subscription';
      log.step(`${newCount} new take${newCount === 1 ? '' : 's'}: ${totalSpark.toFixed(0)} Spark (${usd(totalUsd)}) at pay-as-you-go prices${covered ? ' — covered by your plan, nothing is charged' : ''}${fairUse !== null ? `; about ${fairUse}% of today’s fair-use capacity` : ''}`);
      const limit = Number(process.env.SOGNI_MAX_SPARK || 2000);
      if (!covered && totalSpark > limit && !values.yes && !values['dry-run']) {
        throw new Error(`This run would spend ${totalSpark.toFixed(0)} Spark, above SOGNI_MAX_SPARK (${limit}). Show the quote to whoever pays, then run again with --yes`);
      }
    }

    if (values['dry-run']) {
      for (const w of work.filter(w => !w.resume)) {
        const spec = specs.get(w.film.id);
        log.title(`${w.film.id} take ${w.take} — request (not sent)`);
        console.log(JSON.stringify(printable(createRequest(spec, billing)), null, 2));
      }
      log.ok('Dry run: nothing was submitted');
      return 0;
    }

    const concurrency = Number(values.concurrency ?? DEFAULT_CONCURRENCY[session.tier] ?? 3);
    let createLock = Promise.resolve();
    const results = { completed: [], failed: [], unfinished: [] };

    await pool(work, concurrency, async w => {
      const label = `${w.film.id} take ${w.resume?.take ?? w.take}`;
      let journal;
      let files;
      try {
        if (w.resume) {
          files = w.resume.files;
          journal = readJson(files.journal);
        } else {
          files = takeFiles(paths, w.film.id, w.take);
          const spec = specs.get(w.film.id);
          journal = { ...spec.journal, billing: { mode: billing.mode, tokenType: billing.tokenType, tier: session.tier }, username: session.username,
            appId: `sogni-worlds-kit-${randomUUID()}`, sdk: sdkVersion(), projectId: null, status: 'submitting', startedAt: new Date().toISOString(), output: `take-${w.take}.mp4` };
          // Reserve the take before paying: a second run can never submit it twice.
          writeJson(files.journal, journal, { exclusive: true });
          const request = createRequest(spec, billing);
          // Creates run one at a time so an early refusal is attributed to the right take.
          const created = createLock.then(() => refusals.creating(() => client.projects.create(request)));
          createLock = created.catch(() => {});
          let project;
          try {
            project = await created;
          } catch (error) {
            const unassigned = refusals.unassigned();
            journal = { ...journal, status: 'failed', failedAt: new Date().toISOString(), failure: unassigned ?? { code: error?.code ?? null, message: safeError(error).message } };
            writeJson(files.journal, journal);
            throw new RefusedError(journal.failure);
          }
          journal = { ...journal, projectId: project.id, status: 'submitted', submittedAt: new Date().toISOString() };
          writeJson(files.journal, journal);
          log.step(`${label}: submitted ${project.id}`);
        }

        const result = await waitForProject(client, journal.projectId, { refusals, onStatus: status => log.dim(`${label}: ${status}`) });
        const { bytes, job } = await downloadResult(client, result);
        if (job.result?.sha256 && sha256(bytes) !== job.result.sha256) throw new Error(`${label}: downloaded bytes do not match Sogni's own hash; run again to download again`);
        if (journal.contentFilter === 'on' && (job.triggeredNSFWFilter || job.nsfwDetected)) {
          journal = { ...journal, status: 'failed', failedAt: new Date().toISOString(), failure: { code: null, message: 'the safe-content filter withheld the result' } };
          writeJson(files.journal, journal);
          throw new RefusedError(journal.failure);
        }
        writeFileSync(files.video, bytes);
        let probed = null;
        try { probed = await probe(files.video); } catch { /* screen reports it */ }
        const completedAt = new Date();
        journal = {
          ...journal, status: 'completed', completedAt: completedAt.toISOString(),
          elapsedSeconds: Number(((completedAt - new Date(journal.startedAt)) / 1000).toFixed(1)),
          jobId: job.id ?? null, seed: job.seedUsed ?? journal.seed,
          workerStartTime: job.startTime ?? null, workerEndTime: job.endTime ?? null,
          paymentModel: job.paymentModel ?? result.paymentModel ?? null,
          sha256: sha256(bytes), bytes: bytes.length, probe: probed,
        };
        writeJson(files.journal, journal);
        results.completed.push(label);
        log.ok(`${label}: ${shown(files.video)} (${(bytes.length / 1e6).toFixed(1)} MB, ${journal.elapsedSeconds}s${probed ? `, ${probed.width}×${probed.height}, ${probed.frames} frames` : ''})`);
      } catch (error) {
        if (error instanceof RefusedError) {
          if (journal?.status !== 'failed' && files) {
            journal = { ...journal, status: 'failed', failedAt: new Date().toISOString(), failure: error.failure };
            writeJson(files.journal, journal);
          }
          results.failed.push(`${label}: ${error.message}`);
          log.fail(`${label}: ${error.message}`);
        } else {
          results.unfinished.push(`${label}: ${safeError(error).message}`);
          log.warn(`${label}: ${safeError(error).message}`);
        }
      }
    });

    log.title('Render summary');
    log.info(`${results.completed.length} finished, ${results.failed.length} failed, ${results.unfinished.length} still to pick up`);
    for (const line of results.failed) log.dim(`failed: ${line}`);
    for (const line of results.unfinished) log.dim(`not finished: ${line}`);
    if (results.unfinished.length) log.next(`node world render ${id}   (picks up the unfinished takes; nothing is submitted twice)`);
    else if (values.canary) log.next(`node world screen ${id}   — then look at both films and have them reviewed (node world review ${id}) before rendering the rest`);
    else log.next(`node world screen ${id}`);
    return results.failed.length || results.unfinished.length ? 1 : 0;
  } finally {
    refusals.stop();
    session.close();
  }
}
