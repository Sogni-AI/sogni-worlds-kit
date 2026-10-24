import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { assembleSeedancePrompt, filmPrompt, isSeedanceFrames, shapeFor } from '../cli/lib/seedance.js';
import { assemblePrompt, canvasByName, CANVASES } from '../cli/lib/h3.js';
import { createRequest, filmBilling, takeSpec } from '../cli/commands/render.js';
import { lintDirection, lintPlan } from '../cli/lib/lint.js';
import { canaryFilms } from '../cli/lib/canary.js';
import { filmsOf } from '../cli/lib/plan.js';
import { quoteFilm } from '../cli/lib/sogni.js';
import { edgeStretch, STRETCH_STEP } from '../cli/lib/screen.js';
import { finishFilm } from '../cli/lib/finish.js';
import { finishingOf } from '../cli/commands/build.js';
import { probe } from '../cli/lib/media.js';
import { tempDir, pathsAt, syntheticVideo } from './helpers.js';

const OPEN = 'Live-action, cinematic, a wide shot begins in the position and framing established by Picture 1: a woman at a bar counter, a barman polishing a glass. ';
const seedanceFilm = (extra = {}) => ({ kind: 'crossing', model: 'seedance-2-5', frames: 121,
  action: `${OPEN}She sets down her glass and says <d>[English] Room 304.</d> Then the barman drops the glass, and it shatters on the floor behind the counter.`,
  sound: 'Glass shatters on tiles; a low murmur fills the bar.', ...extra });

test('Seedance fits the canvases within 2% of its shapes; 3:2 and 2:3 are refused', () => {
  const shape = name => shapeFor(canvasByName(name))?.ratio ?? null;
  assert.deepEqual(CANVASES.map(c => [c.name, shape(c.name)]), [
    ['16:9', '16:9'], ['3:2', null], ['4:3', '4:3'], ['1:1', '1:1'], ['3:4', '3:4'], ['2:3', null], ['9:16', '9:16'],
  ]);
  assert.deepEqual(shapeFor(canvasByName('16:9')), { ratio: '16:9', width: 1920, height: 1080 });
});

test('Seedance films last whole seconds, 4 to 30: seconds × 24 + 1 frames', () => {
  for (const frames of [97, 121, 145, 721]) assert.ok(isSeedanceFrames(frames), frames);
  for (const frames of [73, 120, 192, 745]) assert.ok(!isSeedanceFrames(frames), frames);
});

test('the Seedance prompt keeps the plan’s words and says the kit’s markup the way Seedance reads it', () => {
  const prompt = assembleSeedancePrompt(seedanceFilm());
  assert.ok(prompt.includes('established by the first frame: a woman at a bar counter'));
  assert.ok(prompt.includes('says "Room 304." Then the barman drops the glass'), 'spoken lines are quoted speech');
  assert.ok(!/Picture [12]|<d>/.test(prompt));
  assert.ok(prompt.endsWith('\n\nSound: Glass shatters on tiles; a low murmur fills the bar.'));
  assert.equal(prompt.split('established by the last frame at the end of the shot').length, 2, 'lands once');
  const loop = assembleSeedancePrompt({ kind: 'loop', action: 'A static shot holds the position and framing established by Picture 1: grass.', sound: 'Wind.' });
  assert.ok(loop.startsWith('The first frame and the last frame are the same photograph. The camera is locked off on a tripod'));
  assert.ok(!loop.includes('Picture 1'));
  // A film with no model is H3's, exactly as before.
  const h3 = { ...seedanceFilm(), model: undefined, frames: 141 };
  assert.equal(filmPrompt(h3), assemblePrompt(h3));
});

test('lint: a Seedance film needs its frame grid, no keyframes and a canvas it fits; an unknown model is an error', () => {
  const rules = film => lintDirection(film).filter(i => i.level === 'error').map(i => i.rule);
  assert.deepEqual(rules(seedanceFilm()), []);
  assert.deepEqual(rules(seedanceFilm({ frames: 192 })), ['frames']);
  assert.deepEqual(rules(seedanceFilm({ keyframes: [{ image: 'keyframes/x.jpg', frame: 40 }] })), ['keyframes']);
  assert.deepEqual(rules(seedanceFilm({ model: 'seedance-9' })), ['model', 'frames']);
  const plan = canvas => ({ id: 'w', title: 'W', canvas, order: 'free', voices: {}, places: [
    { id: 'bar', still: 'stills/bar.jpg', title: 'Bar', seen: 'x', objects: [{ id: 'glass', label: 'Drop the glass', at: [0.5, 0.4], film: seedanceFilm() }] },
  ] });
  const canvasErrors = canvas => lintPlan(plan(canvas), pathsAt(tempDir('lint-seedance')), { checkFiles: false }).filter(f => f.level === 'error' && f.where.endsWith('.model'));
  assert.equal(canvasErrors('1344x768').length, 0);
  assert.match(canvasErrors('1152x768')[0].message, /3:2 canvas is more than 2% from all of them/);
});

test('a Seedance loop with no length gets 5 s; an H3 loop keeps its 8 s', () => {
  const films = filmsOf({ places: [{ id: 'a', still: 's', objects: [], loop: { model: 'seedance-2-5', action: 'x', sound: 'y' } },
    { id: 'b', still: 's', objects: [], loop: { action: 'x', sound: 'y' } }] });
  assert.deepEqual(films.map(f => f.frames), [121, 192]);
});

test('the canary adds the first Seedance film, so one is judged before the rest are paid for', () => {
  const film = { frames: 192, action: 'x', sound: 'y' };
  const plan = { places: [
    { id: 'a', loop: film, objects: [{ id: 'door', goes: 'b', film }, { id: 'talk', film: { ...film, model: 'seedance-2-5', frames: 121 } }] },
    { id: 'b', loop: film, objects: [{ id: 'fight', film: { ...film, model: 'seedance-2-5', frames: 121 } }] },
  ] };
  assert.deepEqual(canaryFilms(plan).map(f => f.id), ['a-door', 'a-loop', 'a-talk']);
});

test('a Seedance take: its stills resized (never cropped) to its shape, first-and-last-frame, its own sound, paid in tokens', async () => {
  const paths = pathsAt(tempDir('seedance-take'), 'bar');
  mkdirSync(paths.stills, { recursive: true });
  for (const [name, colour] of [['bar', '#335577'], ['street', '#aa7733']]) {
    await sharp({ create: { width: 2688, height: 1536, channels: 3, background: colour } }).jpeg().toFile(join(paths.stills, `${name}.jpg`));
  }
  const plan = { canvas: '1344x768', contentFilter: 'off', places: [] };
  const film = { id: 'bar-glass', from: 'bar', to: 'street', object: 'glass', first: 'stills/bar.jpg', last: 'stills/street.jpg', ...seedanceFilm(), seed: 7 };
  const spec = await takeSpec(plan, paths, film, 1);
  assert.equal(spec.journal.model, 'seedance-2-5');
  assert.deepEqual([spec.journal.width, spec.journal.height], [1920, 1080]);
  assert.deepEqual(spec.journal.fitsCanvas, { width: 2688, height: 1536 }, 'build sizes it back onto the canvas');
  assert.equal(spec.journal.steps, undefined);
  for (const ref of spec.refs) {
    const meta = await sharp(ref.send).metadata();
    assert.deepEqual([meta.width, meta.height], [1920, 1080], ref.role);
  }
  const subscription = { mode: 'subscription', tokenType: 'spark', tier: 'unlimited_pro' };
  assert.deepEqual(filmBilling(film, subscription), { ...subscription, mode: 'tokens' }, 'no plan covers Seedance');
  assert.equal(filmBilling({ ...film, model: undefined }, subscription), subscription, 'an H3 film stays on the plan');
  const request = createRequest(spec, filmBilling(film, subscription));
  assert.equal(request.modelId, 'seedance-2-5');
  assert.equal(request.billingMode, 'tokens');
  assert.equal(request.duration, 5);
  assert.equal(request.generateAudio, true);
  assert.equal(request.seedanceTaskType, undefined, 'first-and-last-frame takes no task type');
  for (const key of ['referenceImageUrls', 'keyframes', 'steps', 'guidance', 'frames', 'sizePreset']) assert.equal(request[key], undefined, key);
  assert.ok(Buffer.isBuffer(request.referenceImage) && Buffer.isBuffer(request.referenceImageEnd));
  assert.equal(request.positivePrompt, assembleSeedancePrompt(film));

  // The same film without a model is an H3 take, exactly as the kit always sent it.
  const h3 = await takeSpec(plan, paths, { ...film, model: undefined, frames: 141 }, 1);
  const h3Request = createRequest(h3, subscription);
  assert.equal(h3Request.modelId, 'minimax-h3-fastvideo-int8_flf2v_turbo_2stage');
  assert.deepEqual([h3Request.width, h3Request.height, h3Request.frames, h3Request.steps, h3Request.sizePreset], [1344, 768, 141, 4, 'custom']);
  assert.equal(h3Request.referenceImage, h3.refs[0].bytes, 'H3 is sent the still itself');
});

test('a Seedance quote prices whole seconds; an H3 quote is asked for as before', async () => {
  const asked = [];
  const client = { projects: { estimateVideoCost: async params => { asked.push(params); return { spark: '739.2', usd: '3.696', sogni: '1' }; } } };
  await quoteFilm(client, { model: 'seedance-2-5', width: 1920, height: 1080, frames: 121, tokenType: 'spark', billingMode: 'tokens' });
  await quoteFilm(client, { model: 'minimax-h3-fastvideo-int8_flf2v_turbo_2stage', width: 1344, height: 768, frames: 192, keyframes: 1, tokenType: 'spark', billingMode: 'subscription' });
  assert.equal(asked[0].duration, 5);
  assert.equal(asked[0].steps, undefined);
  assert.deepEqual([asked[1].duration, asked[1].steps, asked[1].referenceImageCount, asked[1].keyframeCount], [8, 4, 2, 1]);
});

/** Textured grey frames: `widen` stretches a frame sideways by that fraction (a Seedance middle drawn wider), `zoom` scales both ways (a camera). */
function frames(count, { widen = () => 0, zoom = () => 0 } = {}) {
  const W = 384, H = 256;
  let img = new Float64Array(W * H);
  let seed = 7;
  for (let i = 0; i < img.length; i++) { seed = (seed * 16807) % 2147483647; img[i] = seed % 256; }
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) { s += img[(y + dy) * W + x + dx]; n++; }
      out[y * W + x] = s / n;
    }
    img = out;
  }
  return Array.from({ length: count }, (_, k) => {
    const sx = 1 + widen(k) + zoom(k), sy = 1 + zoom(k);
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = Math.min(W - 1.001, Math.max(0, (x - W / 2) / sx + W / 2)), v = Math.min(H - 1.001, Math.max(0, (y - H / 2) / sy + H / 2));
      const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0, i = v0 * W + u0;
      out[y * W + x] = Math.round((img[i] * (1 - fu) + img[i + 1] * fu) * (1 - fv) + (img[i + W] * (1 - fu) + img[i + W + 1] * fu) * fv);
    }
    return out;
  });
}

test('screen: a film whose middle is drawn wider than its pinned ends is a stretch step; a camera push is not', () => {
  const n = 24;
  const wider = edgeStretch(frames(n, { widen: k => (k > 0 && k < n - 4 ? 0.013 : 0) }));
  assert.ok(wider.worst.stretch >= STRETCH_STEP, `stretch ${wider.worst.stretch}`);
  assert.ok([1, n - 4].includes(wider.worst.frame), `at ${wider.worst.frame}`);
  const push = edgeStretch(frames(n, { zoom: k => k * 0.004 }));
  assert.ok(push.worst.stretch < STRETCH_STEP, `a push in both directions reads ${push.worst.stretch}`);
  assert.ok(edgeStretch(frames(n)).worst.stretch < 0.001);
});

test('build sizes a Seedance take onto the canvas; an H3 take is finished exactly as before', async () => {
  const dir = tempDir('seedance-fit');
  const input = join(dir, 'take.mp4');
  await syntheticVideo(input, { source: 'testsrc2=size=SIZE:rate=24', seconds: 1, size: '192x108' });
  const fitted = await finishFilm(input, join(dir, 'out.mp4'), join(dir, 'out-720.mp4'), { size: { width: 224, height: 128 } });
  assert.deepEqual([fitted.width, fitted.height], [224, 128]);
  const half = await probe(join(dir, 'out-720.mp4'));
  assert.deepEqual([half.width, half.height], [112, 64]);
  const paths = pathsAt(dir, 'w');
  const plan = { canvas: '1344x768' };
  const film = { kind: 'crossing', first: 'stills/a.jpg', from: 'a' };
  assert.equal(finishingOf(paths, plan, film, { sha: 'abc', journal: {} }).source, 'abc', 'an H3 take keeps its manifest key: nothing is rebuilt');
  const seedance = finishingOf(paths, plan, film, { sha: 'abc', journal: { model: 'seedance-2-5' } });
  assert.deepEqual(seedance.finishing.size, { width: 2688, height: 1536 });
  assert.equal(seedance.source, 'abc+fit 2688x1536');
});
