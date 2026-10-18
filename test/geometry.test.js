// Where the player puts a label: beside a small object, never on top of it.
// The player is TypeScript; Node reads it directly from 22.18 (type stripping),
// so on an older Node these tests are skipped rather than failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const strips = Boolean(process.features?.typescript);
const geometry = () => import('../player/src/geometry.ts');

// A pistol on a desk, traced in a 1536 × 878 space (from a real one-shot world).
const pistol = { width: 1536, height: 878, path: 'M1036 558L1147 614L1141 628L1109 633L1069 621L1037 607L1033 563Z' };
// A neon sign along the top of the picture.
const sign = { width: 1536, height: 878, path: 'M1266 74L1377 138L1376 226L1290 269L1061 284L1057 207L1083 165L1170 97Z' };
// A bed that fills most of the picture.
const bed = { width: 1000, height: 1000, path: 'M50 300L950 300L950 980L50 980Z' };

test('the box of an outline, as shares of the picture', { skip: !strips }, async () => {
  const { outlineBox } = await geometry();
  const [left, top, right, bottom] = outlineBox(pistol);
  assert.ok(Math.abs(left - 1033 / 1536) < 1e-9 && Math.abs(right - 1147 / 1536) < 1e-9);
  assert.ok(Math.abs(top - 558 / 878) < 1e-9 && Math.abs(bottom - 633 / 878) < 1e-9);
});

test('a label written on a small object moves just above it', { skip: !strips }, async () => {
  const { labelPlacement } = await geometry();
  const placed = labelPlacement({ at: [0.72, 0.69], outline: pistol });
  assert.equal(placed.anchor, 'above');
  assert.ok(Math.abs(placed.y - 558 / 878) < 1e-9, 'its bottom sits on the object\'s top edge');
  assert.ok(Math.abs(placed.x - (1033 + 1147) / 2 / 1536) < 1e-9, 'centred over the object');
});

test('near the top of the picture it goes below the object instead', { skip: !strips }, async () => {
  const { labelPlacement } = await geometry();
  const placed = labelPlacement({ at: [0.78, 0.2], outline: sign });
  assert.equal(placed.anchor, 'below');
  assert.ok(Math.abs(placed.y - 284 / 878) < 1e-9);
});

test('a label placed beside its object, or on a big one, stays where the plan put it', { skip: !strips }, async () => {
  const { labelPlacement } = await geometry();
  assert.deepEqual(labelPlacement({ at: [0.4, 0.5], outline: pistol }), { x: 0.4, y: 0.5, anchor: 'centre' });
  assert.deepEqual(labelPlacement({ at: [0.5, 0.6], outline: bed }), { x: 0.5, y: 0.6, anchor: 'centre' });
  assert.deepEqual(labelPlacement({ at: [0.5, 0.6], outline: null }), { x: 0.5, y: 0.6, anchor: 'centre' });
});
