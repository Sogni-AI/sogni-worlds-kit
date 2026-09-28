import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAction } from '../cli/commands/status.js';

const done = {
  id: 'trip', exists: true, photos: 3, photosNotIngested: 0, places: 3, stillsMissing: [], planWritten: true, errors: [], warnings: [],
  selections: { needed: [], done: 3, failed: [] }, films: 5, takes: 5,
  byState: { unrendered: [], rendering: [], failed: [], unjudged: [], rejected: [], approved: ['a', 'b', 'c', 'd', 'e'] },
  unscreened: [], unlooked: [], unjudged: [], narrationNeeded: [], musicNeeded: false, built: true, buildStale: false,
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
