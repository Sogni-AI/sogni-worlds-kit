import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAction } from '../cli/commands/status.js';

const done = {
  id: 'trip', exists: true, photos: 3, photosNotIngested: 0, places: 3, stillsMissing: [], planWritten: true, errors: [], warnings: [],
  selections: { needed: [], done: 3, failed: [] }, films: 5, takes: 5,
  byState: { unrendered: [], rendering: [], failed: [], unjudged: [], rejected: [], approved: ['a', 'b', 'c', 'd', 'e'] },
  unscreened: [], unlooked: [], unjudged: [], narrationNeeded: [], musicNeeded: false, built: true, buildStale: false,
  canary: { ids: ['a', 'b'], films: [], state: 'approved', waiting: [] },
};
const next = changes => nextAction({ ...done, ...changes }).command;

test('the next action follows the order a world is built', () => {
  assert.match(next({ exists: false }), /^node world new trip/);
  assert.match(next({ places: 0, photos: 0 }), /photos/);
  assert.match(next({ photosNotIngested: 2 }), /^node world ingest/);
  assert.match(next({ planWritten: false }), /write the plan/);
  assert.match(next({ errors: [{}] }), /^node world lint/);
  assert.match(next({ selections: { needed: ['a-door'], done: 0, failed: [] } }), /^node world select/);
  assert.match(next({ takes: 0 }), /--canary/);
  assert.match(next({ byState: { ...done.byState, rendering: ['a'] } }), /^node world render/);
  assert.match(next({ unscreened: ['a take 1'] }), /^node world screen/);
  assert.match(next({ unlooked: [{ film: 'a', take: 1 }], unjudged: ['a take 1'] }), /node world reject trip a 1/);
  assert.match(next({ unjudged: ['a take 1'] }), /^node world review/);
  assert.match(next({ byState: { ...done.byState, rejected: ['b'] } }), /--only b/);
  assert.match(next({ byState: { ...done.byState, unrendered: ['c'] } }), /node world render trip$/);
  assert.match(next({ narrationNeeded: ['a'] }), /^node world narrate/);
  assert.match(next({ musicNeeded: true }), /^node world music/);
  assert.match(next({ built: false }), /^node world build/);
  assert.match(next({ buildStale: true }), /^node world build/);
  assert.match(next({}), /^node world play/);
});

test('earlier steps win over later ones', () => {
  assert.match(next({ errors: [{}], takes: 0, built: false }), /^node world lint/);
  assert.match(next({ unscreened: ['x'], unjudged: ['x'], byState: { ...done.byState, rejected: ['b'] } }), /^node world screen/);
});

test('before photos, the agent interviews the person and names the photos in story order', () => {
  const command = next({ places: 0, photos: 0 });
  assert.match(command, /interview the person/);
  assert.match(command, /01-harbour\.jpg/);
});

test('once the plan lints clean and nothing is spent, the person sees the plan first', () => {
  assert.match(next({ takes: 0, selections: { needed: ['a-door'], done: 0, failed: [] } }), /node world plan trip.*node world select trip/);
  assert.match(next({ takes: 0, selections: { needed: [], done: 0, failed: [] } }), /node world plan trip.*--canary/);
  // After selections exist, the plan was shown: selecting the rest goes straight on.
  assert.match(next({ takes: 0, selections: { needed: ['b-gate'], done: 1, failed: [] } }), /^node world select trip/);
});

test('the canary: never a plain render until it is approved', () => {
  const canary = state => ({ ids: ['a', 'b'], films: [], state, waiting: ['a'] });
  assert.match(next({ canary: canary('rendering'), byState: { ...done.byState, rendering: ['a'], unrendered: ['c'] } }), /^node world render trip --canary/);
  assert.match(next({ canary: canary('unjudged'), unscreened: ['a take 1'], byState: { ...done.byState, unrendered: ['c'] } }), /^node world screen trip/);
  assert.match(next({ canary: canary('unjudged'), unjudged: ['a take 1'], byState: { ...done.byState, unrendered: ['c'] } }), /^node world review trip/);
  assert.match(next({ canary: canary('rejected'), byState: { ...done.byState, rejected: ['a'], unrendered: ['c'] } }), /--only a$/);
  assert.match(next({ canary: canary('failed'), byState: { ...done.byState, failed: ['a'], unrendered: ['c'] } }), /^node world render trip --only a$/);
  // Approved: the rest of the world renders.
  assert.match(next({ byState: { ...done.byState, unrendered: ['c'] } }), /node world render trip$/);
});
