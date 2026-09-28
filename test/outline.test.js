import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskOutline, tidyMask, traceRings } from '../cli/lib/outline.js';

function mask(width, height, on) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (on(x, y)) pixels[y * width + x] = 1;
  return { pixels, width, height };
}

test('a filled rectangle traces to its four corners', () => {
  const m = mask(100, 80, (x, y) => x >= 20 && x < 60 && y >= 10 && y < 50);
  const outline = maskOutline(m);
  assert.equal(outline.cleanup.rings, 1);
  assert.equal(outline.cleanup.keptVertices, 4);
  assert.match(outline.path, /^M20 10L60 10L60 50L20 50Z$/);
  assert.equal(outline.coverage, (40 * 40) / (100 * 80));
});

test('diagonal neighbours stay separate rings', () => {
  const m = mask(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2));
  assert.equal(traceRings(m).length, 2);
});

test('specks are dropped and pinholes filled', () => {
  const m = mask(100, 100, (x, y) => (x >= 10 && x < 90 && y >= 10 && y < 90 && !(x === 50 && y === 50)) || (x === 2 && y === 2));
  const tidy = tidyMask(m);
  assert.equal(tidy.pixels[2 * 100 + 2], 0, 'speck removed');
  assert.equal(tidy.pixels[50 * 100 + 50], 1, 'hole filled');
  assert.equal(tidy.cleanup.islandsDropped, 1);
  assert.equal(tidy.cleanup.holesFilled, 1);
});

test('a circle simplifies to far fewer points than its pixel edge', () => {
  const m = mask(200, 200, (x, y) => (x - 100) ** 2 + (y - 100) ** 2 < 70 ** 2);
  const outline = maskOutline(m);
  assert.equal(outline.cleanup.rings, 1);
  assert.ok(outline.cleanup.keptVertices < outline.cleanup.tracedVertices / 5);
  assert.ok(outline.cleanup.keptVertices > 12);
});
