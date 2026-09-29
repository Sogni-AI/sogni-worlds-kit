import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canaryFilms, canaryGate, canaryNext, canaryStatus } from '../cli/lib/canary.js';
import { filmsToRender } from '../cli/commands/render.js';
import { tempDir, pathsAt } from './helpers.js';

const film = { frames: 192, action: 'x', sound: 'y' };
const plan = {
  places: [
    { id: 'a', objects: [{ id: 'moment', film }, { id: 'door', goes: 'b', film }], loop: film },
    { id: 'b', objects: [{ id: 'gate', goes: 'c', film }], loop: film },
    { id: 'c', objects: [], loop: film },
  ],
};

/** A world folder where each named film has one finished take, with an optional verdict. */
function world(takes) {
  const paths = pathsAt(tempDir('canary'));
  const verdicts = {};
  for (const [id, verdict] of Object.entries(takes)) {
    mkdirSync(join(paths.renders, id), { recursive: true });
    const status = verdict === 'rendering' ? 'submitted' : 'completed';
    writeFileSync(join(paths.renders, id, 'take-1.json'), JSON.stringify({ status, sha256: `sha-${id}`, projectId: 'p' }));
    if (!['rendering', 'unjudged'].includes(verdict)) verdicts[`sha-${id}`] = { verdict };
  }
  mkdirSync(paths.review, { recursive: true });
  writeFileSync(join(paths.review, 'verdicts.json'), JSON.stringify(verdicts));
  return paths;
}

test('the canary is the first crossing and the first loop in story order', () => {
  assert.deepEqual(canaryFilms(plan).map(f => f.id).sort(), ['a-door', 'a-loop']);
  assert.deepEqual(canaryFilms({ places: [{ id: 'a', objects: [{ id: 'm', film }] }] }).map(f => f.id), ['a-m']);
});

test('the canary state reports what is in the way, most urgent first', () => {
  assert.equal(canaryStatus(plan, world({})).state, 'unrendered');
  assert.equal(canaryStatus(plan, world({ 'a-door': 'rendering', 'a-loop': 'rendering' })).state, 'rendering');
  assert.equal(canaryStatus(plan, world({ 'a-door': 'unjudged', 'a-loop': 'approved' })).state, 'unjudged');
  const rejected = canaryStatus(plan, world({ 'a-door': 'rejected', 'a-loop': 'approved' }));
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.waiting, ['a-door']);
  assert.equal(canaryStatus(plan, world({ 'a-door': 'approved', 'a-loop': 'approved' })).state, 'approved');
});

test('render refuses every other film until the canary is approved', () => {
  const others = ['a-moment', 'b-gate', 'b-loop', 'c-loop'];
  for (const state of ['rendering', 'unjudged', 'rejected']) {
    const status = canaryStatus(plan, world({ 'a-door': state, 'a-loop': state }));
    const refusal = canaryGate(status, ['a-door', 'a-loop', ...others], 'trip');
    assert.match(refusal, /canary \(a-door and a-loop\) is not approved/, state);
    assert.match(refusal, /--skip-canary/);
  }
  // A retake of a canary film itself is allowed; the approved canary lets everything through.
  const rejected = canaryStatus(plan, world({ 'a-door': 'rejected', 'a-loop': 'approved' }));
  assert.equal(canaryGate(rejected, ['a-door'], 'trip'), null);
  const approved = canaryStatus(plan, world({ 'a-door': 'approved', 'a-loop': 'approved' }));
  assert.equal(canaryGate(approved, others, 'trip'), null);
});

test('while the canary renders, the next step is to pick it up, never a plain render', () => {
  const status = canaryStatus(plan, world({ 'a-door': 'rendering', 'a-loop': 'rendering' }));
  assert.match(canaryNext(status, 'trip').command, /^node world render trip --canary/);
  assert.match(canaryNext(canaryStatus(plan, world({ 'a-door': 'unjudged', 'a-loop': 'unjudged' })), 'trip').command, /node world screen trip.*node world review trip/);
});

test('render --canary selects exactly the canary films', () => {
  const selected = filmsToRender(plan, world({}), { canary: true }).map(entry => entry.film.id);
  assert.deepEqual(selected.sort(), ['a-door', 'a-loop']);
});
