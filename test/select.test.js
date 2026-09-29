import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samPrompt, selectionAction, selectionInputsHash } from '../cli/commands/select.js';

const select = { positive: [[0.5, 0.5]], negative: [[0.2, 0.8]] };
const current = (clicks = select, still = 'still-1') => ({ inputsHash: selectionInputsHash(clicks, still), prompt: samPrompt(clicks), stillSha256: still });

test('an outline is made again when its clicks or its still change, without --redo', () => {
  const made = { status: 'completed', inputsHash: selectionInputsHash(select, 'still-1') };
  assert.equal(selectionAction(made, current()), 'skip');
  assert.equal(selectionAction(made, current({ ...select, negative: [[0.3, 0.7]] })), 'select');
  assert.equal(selectionAction(made, current(select, 'still-2')), 'select');
});

test('outlines made before hashes were recorded compare their prompt and still', () => {
  const legacy = { status: 'completed', prompt: samPrompt(select), stillSha256: 'still-1' };
  assert.equal(selectionAction(legacy, current()), 'skip');
  assert.equal(selectionAction(legacy, current({ positive: [[0.6, 0.5]] })), 'select');
});

test('naming an object with --only selects it again even when nothing changed', () => {
  const made = { status: 'completed', inputsHash: selectionInputsHash(select, 'still-1') };
  assert.equal(selectionAction(made, current(), { named: true }), 'select');
  assert.equal(selectionAction(made, current(), { redo: true }), 'select');
});

test('a submitted job is collected; a submit with an unknown outcome is never repeated silently', () => {
  assert.equal(selectionAction({ status: 'submitted', projectId: 'p' }, current()), 'resume');
  assert.equal(selectionAction({ status: 'submitting' }, current()), 'unknown');
  assert.equal(selectionAction({ status: 'submitting' }, current(), { named: true }), 'select');
});

test('a failed outline waits for new clicks rather than failing again the same way', () => {
  const failed = { status: 'failed', inputsHash: selectionInputsHash(select, 'still-1') };
  assert.equal(selectionAction(failed, current()), 'skip');
  assert.equal(selectionAction(failed, current({ positive: [[0.4, 0.4]] })), 'select');
});
