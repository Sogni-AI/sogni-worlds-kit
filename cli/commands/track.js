import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { parse } from '../index.js';
import { readPlan, filmsOf } from '../lib/plan.js';
import { filmId, loopId, resolveWorldId, shown } from '../lib/paths.js';
import { readJson, sha256, sha256File, writeJson } from '../lib/files.js';
import { approvedTake, listTakes } from '../lib/takes.js';
import { acquireRenderLock } from '../lib/renderlock.js';
import { probeTrackingVideo } from '../lib/media.js';
import { connect, describeBilling, downloadResult, RefusedError, safeError, waitForProject, watchRefusals } from '../lib/sogni.js';
import { log } from '../lib/log.js';
import { maskVideoOutlines, SAM_VIDEO_MODEL, trackingArtifactsAvailable, trackingAttempt, trackingSource, trackingSourceFile,
  validateTrackingReceipt, videoSelectionAction, videoSelectionHash, videoSelectionPrompt } from '../lib/video-selection.js';

export const summary = 'Track clickable objects through approved place loops with SAM 3 video';
export const usage = 'node world track [world] [--only <place>-<object> ...] [--frame <index>] [--object-index <index>] [--quote] [--redo]\n\n' +
  "Uses each object's existing select clicks or text on the approved loop. The\n" +
  'default selection frame is 0. Saves a frame-aligned mask and moving outlines\n' +
  'without changing the still or film. Run world build to use them in the player.\n' +
  'Quotes before submitting. --quote makes no model request. Interrupted jobs\n' +
  'are collected, never silently repeated; --redo cannot bypass an unknown submit.';

const validKey = key => typeof key === 'string' && /^[a-z0-9_-]+$/.test(key);
const attempts = (paths, key, inputsHash) => {
  const dir = join(paths.selections, 'video');
  if (!existsSync(dir)) return [];
  const prefix = key + '-' + inputsHash + '-';
  return readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.attempt.json'))
    .map(name => ({ name, number: Number(name.slice(prefix.length, -'.attempt.json'.length)) }))
    .filter(x => Number.isSafeInteger(x.number) && x.number > 0).sort((a, b) => a.number - b.number);
};

function latestAttempt(paths, key, inputsHash) {
  const rows = attempts(paths, key, inputsHash), latest = rows.at(-1);
  return latest ? { file: join(paths.selections, 'video', latest.name), journal: readJson(join(paths.selections, 'video', latest.name)), number: latest.number } : null;
}

/** Changing clicks cannot abandon an earlier paid or uncertain submission. */
function unfinishedAttempt(paths, key) {
  const dir = join(paths.selections, 'video');
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter(name => new RegExp('^' + key + '-[a-f0-9]{64}-[0-9]+\\.attempt\\.json$').test(name));
  const pending = names.map(name => ({ file: join(dir, name), journal: readJson(join(dir, name)) }))
    .filter(row => row.journal.key === key && ['submitting', 'submitted'].includes(row.journal.status));
  if (pending.length > 1) throw new Error(key + ': reconcile multiple unfinished tracking projects before making another request');
  return pending[0] ?? null;
}

/** One real worker request, or collection of the exact already submitted job. */
export async function trackObject(task, session, refusals, { redo = false, wait = waitForProject, download = downloadResult, trace = maskVideoOutlines } = {}) {
  const { paths, key, select, source, sourceSha256, prompt, inputsHash } = task;
  if (!validKey(key)) throw new Error('Use ordinary place and object ids for video tracking');
  // The selection directory is generated inside the world, never through a
  // symlink supplied by an imported world.
  if (existsSync(paths.selections)) trackingSourceFile(paths, paths.selections);
  const videoDir = join(paths.selections, 'video');
  if (existsSync(videoDir)) trackingSourceFile(paths, videoDir);
  mkdirSync(videoDir, { recursive: true });
  const pointer = join(paths.selections, key + '.video.json');
  let previous = unfinishedAttempt(paths, key) ?? latestAttempt(paths, key, inputsHash);
  let action = videoSelectionAction(previous?.journal, inputsHash, { redo });
  if (action === 'unknown') throw new Error(key + ': the last submit has an unknown outcome. Reconcile that project before making another request');
  if (action === 'skip') {
    if (trackingArtifactsAvailable(paths, previous.journal)) return previous.journal;
    if (!previous.journal.projectId) throw new Error('The completed tracking receipt has no recoverable project');
    action = 'resume';
  }
  if (action === 'failed') throw new Error(key + ': the previous job failed. Change its selection or use --redo after checking the failure');
  let journal, file;
  if (action === 'resume') {
    ({ journal, file } = previous);
    journal = { ...journal, status: 'submitted' };
  } else {
    const files = trackingAttempt(paths, key);
    file = join(paths.selections, 'video', key + '-' + inputsHash + '-' + ((previous?.number ?? 0) + 1) + '.attempt.json');
    journal = { key, model: SAM_VIDEO_MODEL, prompt, inputsHash, sourceSha256, source,
      sourceTake: task.sourceTake, cleanup: select.cleanup ?? null, status: 'submitting', startedAt: new Date().toISOString(),
      attempt: files.attempt, mask: basename(files.mask), outlines: basename(files.outlines) };
    // An immutable numbered claim closes the simultaneous-submit race. An
    // existing claim is inspected on the next invocation, never overwritten.
    writeJson(file, journal, { exclusive: true });
    writeJson(pointer, journal);
  }
  const save = value => { journal = value; writeJson(file, journal); writeJson(pointer, journal); };
  if (!/^[a-z0-9_-]+\.mask\.mp4$/.test(journal.mask) || !/^[a-z0-9_-]+\.outlines\.json$/.test(journal.outlines)) {
    throw new Error('Invalid tracking artifact names');
  }
  let submissionStarted = false;
  try {
    let project;
    if (journal.status !== 'submitted') {
      const bytes = readFileSync(task.sourceFile);
      if (sha256(bytes) !== journal.sourceSha256) throw new Error('The loop changed before upload; no request was sent');
      submissionStarted = true;
      project = await refusals.creating(() => session.client.projects.create({
        type: 'video', modelId: SAM_VIDEO_MODEL, positivePrompt: '', numberOfMedia: 1,
        referenceVideo: new Blob([bytes], { type: 'video/mp4' }), sam3VideoPrompt: journal.prompt, ...journal.source,
        tokenType: session.billing.tokenType, billingMode: session.billing.mode,
        network: 'fast', disableNSFWFilter: true,
      }));
      save({ ...journal, status: 'submitted', projectId: project.id, pid: process.pid, appId: session.appId });
    }
    const result = await wait(session.client, { project, projectId: journal.projectId, ownerPid: journal.pid }, { refusals, timeoutMs: 10 * 60_000 });
    const { bytes, job } = await download(session.client, result, { contentType: 'video/mp4' });
    const proof = validateTrackingReceipt(job, bytes, journal.sourceSha256, journal.source);
    const maskFile = join(paths.selections, 'video', journal.mask);
    mkdirSync(join(paths.selections, 'video'), { recursive: true });
    // A retry can replace a failed transfer of this mask, never a different take.
    const tmp = maskFile + '.' + randomUUID() + '.next';
    writeFileSync(tmp, bytes);
    renameSync(tmp, maskFile);
    const outlines = await trace(maskFile, journal.source, journal.cleanup ?? {});
    const outlineFile = join(paths.selections, 'video', journal.outlines);
    writeJson(outlineFile, outlines);
    save({ ...journal, status: 'completed', completedAt: new Date().toISOString(), maskSha256: sha256(bytes),
      outlinesSha256: sha256File(outlineFile), provenance: proof });
    return journal;
  } catch (error) {
    // A network failure after submission leaves the exact project resumable.
    // A failed/uncertain submit keeps its reservation, including with --redo.
    // One owner-scoped lookup distinguishes a confirmed terminal project from
    // an interrupted wait. A lookup error or unknown state never permits replay.
    let terminal = null;
    if (journal.projectId && session.client.projects.getStatus) {
      try {
        const status = await session.client.projects.getStatus(journal.projectId);
        if (status.finished === true && ['completed', 'failed', 'canceled'].includes(status.status)) terminal = status.status;
      } catch { /* Keep the existing project resumable when its state is unknown. */ }
    }
    save({ ...journal, ...(terminal || error instanceof RefusedError || (!submissionStarted && !journal.projectId) ? { status: 'failed' } : {}),
      ...(terminal ? { projectStatus: terminal } : {}),
      lastError: safeError(error).message, checkedAt: new Date().toISOString() });
    throw error;
  }
}

export async function run(argv) {
  const { values, world } = parse(argv, { only: { type: 'string', multiple: true }, frame: { type: 'string', default: '0' },
    'object-index': { type: 'string', default: '0' }, quote: { type: 'boolean' }, redo: { type: 'boolean' } });
  const id = resolveWorldId(world), { paths, plan } = readPlan(id);
  const only = new Set(values.only ?? []), known = plan.places.flatMap(p => p.objects.filter(o => o.select).map(o => filmId(p.id, o.id)));
  for (const key of only) if (!known.includes(key)) throw new Error('No selected object named ' + key);
  const todo = [], films = filmsOf(plan);
  for (const place of plan.places) {
    const selected = place.objects.filter(o => o.select && (!only.size || only.has(filmId(place.id, o.id))));
    if (!selected.length) continue;
    const film = films.find(f => f.id === loopId(place.id));
    if (!film) throw new Error(place.id + ': video tracking needs a place loop');
    const take = approvedTake(listTakes(paths, film.id, undefined, undefined, film));
    if (!take || take.journal.status !== 'completed') throw new Error(place.id + ': approve its completed loop before tracking');
    const sourceFile = trackingSourceFile(paths, take.files.video), sourceSha256 = sha256File(sourceFile);
    if (sourceSha256 !== take.sha) throw new Error(place.id + ': the loop changed after its approval');
    const source = trackingSource(await probeTrackingVideo(sourceFile));
    for (const object of selected) {
      const key = filmId(place.id, object.id);
      if (!validKey(key)) throw new Error('Use ordinary place and object ids for video tracking');
      const prompt = videoSelectionPrompt(object.select, Number(values.frame), Number(values['object-index']));
      if (prompt.frameIndex >= source.frames) throw new Error('The selected frame is outside ' + place.id + "'s loop");
      const inputsHash = videoSelectionHash(sourceSha256, prompt, object.select.cleanup);
      const previous = unfinishedAttempt(paths, key) ?? latestAttempt(paths, key, inputsHash);
      const action = videoSelectionAction(previous?.journal, inputsHash, { redo: values.redo });
      if (action === 'unknown') throw new Error(key + ': the last submit has an unknown outcome; reconcile it before tracking again');
      if (action === 'skip' && trackingArtifactsAvailable(paths, previous.journal)) continue;
      todo.push({ paths, key, select: object.select, sourceFile, sourceSha256, source, prompt, inputsHash,
        sourceTake: { film: film.id, take: take.take, sha256: take.sha } });
    }
  }
  if (!todo.length) { log.ok('Every selected object already has video tracking for its current approved loop'); return 0; }
  const release = acquireRenderLock(paths, todo.map(t => t.key));
  let session, refusals;
  try {
    session = await connect({ worldDir: paths.dir }); refusals = watchRefusals(session.client);
    log.step('Signed in as ' + session.username + '. Billing: ' + describeBilling(session.billing));
    for (const task of todo) {
      const quote = await session.client.projects.estimateVideoCost({ model: SAM_VIDEO_MODEL, width: task.source.width,
        height: task.source.height, duration: task.source.frames / task.source.fps, fps: task.source.fps,
        steps: 1, numberOfMedia: 1, network: 'fast', tokenType: session.billing.tokenType, billingMode: session.billing.mode });
      const usd = Number(quote.usd);
      if (!Number.isFinite(usd) || usd < 0) throw new Error('The video tracking estimate did not include a valid price');
      log.info(task.key + ': ' + task.source.frames + ' frames, $' + usd.toFixed(4) + ' estimate');
    }
    if (values.quote) return 0;
    for (const task of todo) {
      const receipt = await trackObject(task, session, refusals, { redo: values.redo });
      log.ok(task.key + ': ' + receipt.source.frames + ' moving outlines saved');
    }
    log.next('node world build ' + id);
    return 0;
  } finally {
    refusals?.stop(); session?.close(); release();
  }
}
