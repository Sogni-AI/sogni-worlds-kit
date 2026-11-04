// Seedance drafts: every take renders at 480p, the approved one is made at 1080p from the
// draft itself, the quote and the spending ledger keep the two apart, and a draft Sogni no
// longer offers fails with what to do instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import createJobRequestMessage from '../node_modules/@sogni-ai/sogni-client/dist-esm/Projects/createJobRequestMessage.js';
import { createRequest, draftReport, filmsToRender, finalSpec, lapsedMessage, planWork, stageOf, takeSpec } from '../cli/commands/render.js';
import { draftLapsed, isDraft, SHAPES } from '../cli/lib/seedance.js';
import { draftToFinalize, filmState, listTakes, recordVerdict } from '../cli/lib/takes.js';
import { quoteFilm } from '../cli/lib/sogni.js';
import { readSpending, spendingReport, trackSpending } from '../cli/lib/spending.js';
import { canaryNext, canaryStatus } from '../cli/lib/canary.js';
import { nextAction } from '../cli/commands/status.js';
import { awaitingFilms } from '../cli/commands/review.js';
import { buildWorld } from '../cli/commands/build.js';
import { writeJson, sha256File } from '../cli/lib/files.js';
import { pathsAt, syntheticVideo, tempDir } from './helpers.js';

const HOUR = 60 * 60_000;
const later = () => new Date(Date.now() + HOUR).toISOString();
const earlier = () => new Date(Date.now() - HOUR).toISOString();
const DRAFT_JOB = '21CD3DE1-6B46-4B09-A0A0-5E9430216400';
const tokens = { mode: 'tokens', tokenType: 'spark' };
// The SDK's own request builder, with the video size limits Sogni advertises for Seedance 2.5.
const sdkRequest = request => createJobRequestMessage('00000000-0000-4000-8000-000000000001', request, {
  type: 'video', width: { min: 480, max: 2206, step: 8, default: 1280 }, height: { min: 432, max: 1920, step: 8, default: 720 },
  sampler: { allowed: [], default: null }, scheduler: { allowed: [], default: null },
});

const film = {
  id: 'bar-talk', kind: 'moment', from: 'bar', to: 'bar', object: 'talk', model: 'seedance-2-5', frames: 97, seed: 7,
  first: 'stills/bar.jpg', last: 'stills/bar.jpg',
  action: 'Live-action, cinematic, a wide shot begins in the position and framing established by Picture 1: a woman at a bar counter. She says <d>[English] Room 304.</d>',
  sound: 'A low murmur fills the bar.',
};
const plan = { canvas: '1344x768', contentFilter: 'off', places: [{ id: 'bar', still: 'stills/bar.jpg', objects: [{ id: 'talk', film }] }] };

async function world(prefix) {
  const paths = pathsAt(tempDir(prefix), 'bar');
  mkdirSync(paths.stills, { recursive: true });
  await sharp({ create: { width: 2688, height: 1536, channels: 3, background: '#335577' } }).jpeg().toFile(join(paths.stills, 'bar.jpg'));
  return paths;
}

/** One take on disk: its receipt, a file of its own bytes and, optionally, a verdict. */
function take(paths, n, journal, verdict) {
  const dir = join(paths.renders, film.id);
  mkdirSync(dir, { recursive: true });
  const video = join(dir, `take-${n}.mp4`);
  writeFileSync(video, `${film.id} take ${n}`);
  const sha = sha256File(video);
  writeJson(join(dir, `take-${n}.json`), { film: film.id, take: n, kind: film.kind, model: 'seedance-2-5', status: 'completed', sha256: sha, ...journal });
  if (verdict) recordVerdict(paths, sha, { film: film.id, take: n, verdict, by: 'you' });
  return sha;
}
const draft = (extra = {}) => ({ seedanceDraft: true, width: 854, height: 480, delivered: { width: 854, height: 480 }, frames: 97, seconds: 4.042, seed: 7, prompt: 'the words', promptSha256: 'p',
  projectId: 'DRAFT-PROJECT', draftJobId: DRAFT_JOB, draftExpiresAt: later(), contentFilter: 'off', references: [], ...extra });
const takes = paths => listTakes(paths, film.id, undefined, undefined, film);

test('every Seedance take is a 480p draft at Sogni’s own size for its shape, sent with the stills at 1080p', async () => {
  assert.deepEqual(SHAPES.map(s => [s.ratio, `${s.draft.width}x${s.draft.height}`]),
    [['16:9', '854x480'], ['4:3', '752x560'], ['1:1', '640x640'], ['3:4', '560x752'], ['9:16', '480x854']]);
  const paths = await world('draft-request');
  const spec = await takeSpec(plan, paths, film, 1);
  assert.deepEqual([spec.journal.width, spec.journal.height, spec.journal.seedanceDraft], [854, 480, true]);
  assert.deepEqual(spec.journal.delivered, { width: 854, height: 480 });
  const request = createRequest(spec, tokens);
  assert.deepEqual([request.width, request.height, request.duration, request.seed, request.seedanceDraft], [854, 480, 4, 7, true]);
  // The final is made from the draft's own pictures, so they go at the 1080p shape.
  assert.deepEqual(await sharp(request.referenceImage).metadata().then(m => [m.width, m.height]), [1920, 1080]);
  const frame = sdkRequest(request).keyFrames[0];
  assert.deepEqual([frame.seedanceDraft, frame.width, frame.height, frame.hasReferenceImage, frame.hasReferenceImageEnd], [true, 854, 480, true, true]);
  assert.equal(frame.seedanceDraftJobId, undefined);
});

test('the final names only its draft: Sogni gets none of the inputs the draft already set', async () => {
  const paths = await world('final-request');
  take(paths, 1, draft(), 'approved');
  const picked = draftToFinalize(takes(paths));
  assert.equal(picked.take, 1);
  const spec = finalSpec(plan, paths, film, 2, picked);
  assert.deepEqual([spec.journal.width, spec.journal.height, spec.journal.finalizes, spec.journal.seedanceDraftJobId], [1920, 1080, 1, DRAFT_JOB]);
  assert.deepEqual([spec.journal.prompt, spec.journal.seed, spec.journal.frames, spec.journal.draftProjectId], ['the words', 7, 97, 'DRAFT-PROJECT'], 'its receipt is the draft’s');
  assert.equal(isDraft(spec.journal), false);
  const request = createRequest(spec, tokens);
  assert.deepEqual(request, { type: 'video', modelId: 'seedance-2-5', positivePrompt: '', network: 'fast', tokenType: 'spark', billingMode: 'tokens',
    disableNSFWFilter: true, numberOfMedia: 1, seedanceDraftJobId: DRAFT_JOB, outputFormat: 'mp4' });
  // The SDK refuses a finalize that resends any of these; the request builds cleanly.
  const frame = sdkRequest(request).keyFrames[0];
  assert.equal(frame.seedanceDraftJobId, DRAFT_JOB);
  assert.equal(frame.seedanceDraft, undefined);
  assert.equal(frame.hasReferenceImage, undefined);
});

test('the quote asks for a draft and a final apart, and an H3 quote is unchanged', async () => {
  const asked = [];
  const client = { projects: { estimateVideoCost: async params => { asked.push(params); return { spark: '100', usd: '0.5', sogni: '1' }; } } };
  const base = { model: 'seedance-2-5', frames: 97, tokenType: 'spark', billingMode: 'tokens' };
  await quoteFilm(client, { ...base, width: 854, height: 480, ...stageOf({ seedanceDraft: true }) });
  await quoteFilm(client, { ...base, width: 1920, height: 1080, ...stageOf({ finalizes: 1, seedanceDraftJobId: DRAFT_JOB }) });
  await quoteFilm(client, { ...base, width: 1920, height: 1080 });
  await quoteFilm(client, { model: 'minimax-h3-fastvideo-int8_flf2v_turbo_2stage', width: 1344, height: 768, frames: 192, tokenType: 'spark', billingMode: 'subscription', ...stageOf({}) });
  assert.deepEqual([asked[0].width, asked[0].height, asked[0].duration, asked[0].seedanceDraft, asked[0].seedanceDraftJobId], [854, 480, 4, true, undefined]);
  assert.deepEqual([asked[1].seedanceDraftJobId, asked[1].seedanceDraft], [DRAFT_JOB, undefined]);
  for (const params of asked.slice(2)) assert.ok(!('seedanceDraft' in params) && !('seedanceDraftJobId' in params));
});

test('the spending ledger records the draft and the final as their own charges', async () => {
  const root = tempDir('draft-ledger');
  let n = 0;
  const client = { projects: {
    create: async () => ({ id: `P${++n}` }),
    get: async id => ({ status: 'completed', costActual: { costInUSD: id === 'P1' ? '0.48110517' : '2.6611416', costInToken: id === 'P1' ? '96.221034' : '532.22832' }, paymentModel: 'paid_spark', tokenType: 'spark' }),
  } };
  trackSpending(client, root, { warn() {} });
  await client.projects.create({ type: 'video', modelId: 'seedance-2-5', billingMode: 'tokens', seedanceDraft: true });
  await client.projects.create({ type: 'video', modelId: 'seedance-2-5', billingMode: 'tokens', seedanceDraftJobId: DRAFT_JOB });
  await client.projects.create({ type: 'video', modelId: 'minimax-h3-fastvideo-int8_flf2v_turbo_2stage', billingMode: 'subscription' });
  for (const id of ['P1', 'P2']) await client.projects.get(id);
  const stages = Object.values(readSpending(root).attempts).map(a => [a.projectId, a.seedance ?? null]).sort();
  assert.deepEqual(stages, [['P1', 'draft'], ['P2', 'final'], ['P3', null]]);
  const { models } = spendingReport(root);
  assert.equal(models['sogni:seedance-2-5 draft'].usd, '0.48110517');
  assert.equal(models['sogni:seedance-2-5 final'].usd, '2.6611416');
  assert.ok(models['sogni:minimax-h3-fastvideo-int8_flf2v_turbo_2stage'], 'other models keep their key');
});

test('a draft can be finalized only while Sogni says so; a lapsed one stops the run and says to render a new draft', async () => {
  assert.equal(draftLapsed(draft()), null);
  assert.match(draftLapsed(draft({ draftExpiresAt: earlier() })), /could be made at 1080p only until/);
  assert.match(draftLapsed(draft({ draftExpiresAt: null })), /did not report it as a draft/);
  assert.match(draftLapsed(draft({ draftJobId: null })), /did not report it as a draft/);
  assert.deepEqual(draftReport({ imgID: DRAFT_JOB, result: { seedanceDraft: true, seedanceDraftExpiresAt: '2026-11-04T11:33:53.000Z' } }),
    { draftJobId: DRAFT_JOB, draftExpiresAt: '2026-11-04T11:33:53.000Z' }, 'read from the stored job record');

  const fresh = await world('draft-fresh');
  take(fresh, 1, draft(), 'approved');
  const selected = filmsToRender(plan, fresh);
  assert.deepEqual(selected.map(e => [e.film.id, e.state]), [['bar-talk', 'finalize']], 'a plain render picks up the approved draft');
  for (const only of [false, true]) {
    const { work, lapsed } = planWork(selected, { only });
    assert.deepEqual([work.length, work[0].take, work[0].finalizes.take, lapsed.length], [1, 2, 1, 0]);
  }

  const old = await world('draft-lapsed');
  take(old, 1, draft({ draftExpiresAt: earlier() }), 'approved');
  const plain = planWork(filmsToRender(plan, old));
  assert.deepEqual([plain.work.length, plain.lapsed.map(d => [d.film, d.take])], [0, [['bar-talk', 1]]]);
  const message = lapsedMessage('trip', plain.lapsed);
  assert.match(message, /^Nothing was rendered/);
  assert.match(message, /node world render trip --only bar-talk/);
  // Asked for by name, it renders a new draft, never a final of the lapsed one.
  const named = planWork(filmsToRender(plan, old, { only: ['bar-talk'] }), { only: true });
  assert.deepEqual([named.work.length, named.work[0].take, named.work[0].finalizes, named.lapsed.length], [1, 2, undefined, 0]);
});

test('a Seedance film moves draft → approved draft → final → approved, and a 1080p take from before drafts stays approved', async () => {
  const paths = await world('draft-states');
  const state = () => filmState(takes(paths));
  take(paths, 1, draft());
  assert.equal(state(), 'unjudged');
  const second = take(paths, 2, draft());
  recordVerdict(paths, second, { film: film.id, take: 2, verdict: 'approved', by: 'you' });
  recordVerdict(paths, sha256File(join(paths.renders, film.id, 'take-1.mp4')), { film: film.id, take: 1, verdict: 'passed', by: 'you' });
  assert.equal(state(), 'finalize', 'a draft passed over does not wait again once another is approved');
  take(paths, 3, { finalizes: 2, status: 'failed' });
  assert.equal(state(), 'finalize', 'a failed final leaves its draft waiting');
  take(paths, 4, { finalizes: 2, status: 'submitted', projectId: 'F' });
  assert.equal(state(), 'rendering');
  const final = take(paths, 4, { finalizes: 2, width: 1920, height: 1080 });
  assert.equal(state(), 'unjudged');
  recordVerdict(paths, final, { film: film.id, take: 4, verdict: 'rejected', by: 'you' });
  assert.equal(state(), 'rejected', 'a rejected final means rewriting the words and a new draft');
  recordVerdict(paths, final, { film: film.id, take: 4, verdict: 'approved', by: 'you' });
  assert.equal(state(), 'approved');

  const before = await world('draft-before');
  take(before, 1, { width: 1920, height: 1080, frames: 97 }, 'approved');
  assert.equal(filmState(takes(before)), 'approved');
  assert.equal(draftToFinalize(takes(before)), null);
});

test('next and the canary send an approved draft to render, and a lapsed one to a new draft by name', async () => {
  const paths = await world('draft-next');
  take(paths, 1, draft(), 'approved');
  const canary = canaryStatus(plan, paths);
  assert.deepEqual([canary.state, canary.waiting], ['finalize', ['bar-talk']]);
  assert.match(canaryNext(canary, 'trip').command, /^node world render trip --canary$/);
  const done = {
    id: 'trip', exists: true, photos: 1, photosNotIngested: 0, places: 1, stillsMissing: [], planWritten: true, errors: [], warnings: [],
    selections: { needed: [], done: 0, failed: [] }, films: 1, takes: 1, unscreened: [], unlooked: [], unjudged: [], narrationNeeded: [], musicNeeded: false,
    built: false, buildStale: false, canary: { ids: ['x'], films: [], state: 'approved', waiting: [] },
    byState: { unrendered: [], rendering: [], finalize: ['bar-talk'], failed: [], unjudged: [], rejected: [], approved: [] },
  };
  assert.match(nextAction({ ...done, drafts: [{ film: 'bar-talk', take: 1, expiresAt: later(), lapsed: null }] }).command, /^node world render trip$/);
  assert.match(nextAction({ ...done, drafts: [{ film: 'bar-talk', take: 1, expiresAt: earlier(), lapsed: 'it could be made at 1080p only until then' }] }).command,
    /^node world render trip --only bar-talk/);
});

test('review shows a draft as one, and a final beside the draft it was made from', async () => {
  const paths = await world('draft-review');
  const reviewPlan = { ...plan, places: [{ ...plan.places[0], still: 'stills/bar.jpg' }] };
  take(paths, 1, draft());
  const [waiting] = awaitingFilms(reviewPlan, paths);
  assert.match(waiting.takes[0].meta, /854×480 · seedance-2-5 · 480p draft: approve it to have it made at 1080p \(until /);
  recordVerdict(paths, waiting.takes[0].sha, { film: film.id, take: 1, verdict: 'approved', by: 'you' });
  take(paths, 2, { finalizes: 1, width: 1920, height: 1080, delivered: { width: 1920, height: 1080 } });
  const [final] = awaitingFilms(reviewPlan, paths);
  assert.equal(final.ref.take, 1, 'the approved draft plays beside it');
  assert.deepEqual(final.takes.map(t => t.take), [2]);
  assert.match(final.takes[0].meta, /1920×1080 · seedance-2-5 · the 1080p final of draft take 1/);
});

test('build ships a final, never an approved draft, and counts the draft in the used clip’s cost', async () => {
  const paths = pathsAt(tempDir('draft-build'), 'bar');
  mkdirSync(paths.stills, { recursive: true });
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).jpeg().toFile(join(paths.stills, 'a.jpg'));
  const buildPlan = { id: 'bar', title: 'Bar', order: 'linear', voices: {}, music: null,
    places: [{ id: 'a', title: 'A', still: 'stills/a.jpg', loop: { model: 'seedance-2-5', frames: 49, action: 'x', sound: 'y' }, objects: [] }] };
  const quiet = { step() {}, ok() {}, warn() {}, info() {}, fail() {}, title() {}, next() {}, dim() {} };
  const clip = async (n, journal, verdict) => {
    const video = join(paths.renders, 'a-loop', `take-${n}.mp4`);
    await syntheticVideo(video, { source: 'testsrc2=size=SIZE:rate=24', seconds: 2, tone: 300 + n * 100 });
    const sha = sha256File(video);
    writeJson(join(paths.renders, 'a-loop', `take-${n}.json`), { film: 'a-loop', take: n, kind: 'loop', model: 'seedance-2-5', frames: 49, status: 'completed', sha256: sha, ...journal });
    if (verdict) recordVerdict(paths, sha, { film: 'a-loop', take: n, verdict, by: 'you' });
  };
  await clip(1, { seedanceDraft: true, projectId: 'D1', draftJobId: DRAFT_JOB, draftExpiresAt: later() }, 'approved');
  const waiting = await buildWorld({ paths, plan: buildPlan, say: quiet });
  assert.equal(waiting.films, 0);
  assert.deepEqual(waiting.missing.map(m => [m.film, m.state]), [['a-loop', 'finalize']]);
  const played = await buildWorld({ paths, plan: buildPlan, drafts: true, say: quiet });
  assert.deepEqual([played.films, played.world.draft, played.unapproved], [1, true, ['a-loop take 1']], 'a draft build may play the draft');
  await clip(2, { finalizes: 1, projectId: 'F2', draftProjectId: 'D1' }, 'approved');
  const finished = await buildWorld({ paths, plan: buildPlan, say: quiet });
  assert.deepEqual([finished.films, finished.world.draft, finished.missing.length], [1, undefined, 0]);
  assert.deepEqual(readSpending(paths.dir).selections['build:clips'].projectIds, ['sogni:D1', 'sogni:F2']);
});
