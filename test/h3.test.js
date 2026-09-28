import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignmentLine, assemblePrompt, canvasFor, framesFor, isValidFrames, LANDING, LOOP_LANDING, PIXEL_BUDGET, CANVASES, VALID_FRAMES } from '../cli/lib/h3.js';

test('frame counts sit on the 124 + 17n grid', () => {
  assert.equal(VALID_FRAMES[0], 124);
  assert.equal(VALID_FRAMES.at(-1), 362);
  assert.ok(isValidFrames(192));
  assert.ok(!isValidFrames(193));
  assert.ok(!isValidFrames(379));
  assert.equal(framesFor(8), 192);
  assert.equal(framesFor(6), 141);
  assert.equal(framesFor(60), 362);
  assert.equal(framesFor(1), 124);
});

test('every canvas fits the H3 pixel budget on a 32-px grid', () => {
  for (const canvas of CANVASES) {
    assert.ok(canvas.width * canvas.height <= PIXEL_BUDGET, canvas.name);
    assert.equal(canvas.width % 32, 0);
    assert.equal(canvas.height % 32, 0);
  }
});

test('the canvas follows the photo’s shape', () => {
  assert.equal(canvasFor(6000, 4000).name, '3:2');
  assert.equal(canvasFor(4000, 3000).name, '4:3');
  assert.equal(canvasFor(3840, 2160).name, '16:9');
  assert.equal(canvasFor(3000, 4500).name, '2:3');
  assert.equal(canvasFor(2000, 2000).name, '1:1');
});

test('alignment line: first and last frame, and with keyframes in time order', () => {
  assert.equal(alignmentLine(294),
    'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 12.25-second mark of the target video.');
  assert.equal(alignmentLine(192, [90, 48]),
    'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 3 (from Shot 1) aligns with the 2.00-second mark of the target video; Picture 4 (from Shot 1) aligns with the 3.75-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.');
});

test('assemblePrompt adds the landing only when the direction does not land itself', () => {
  const crossing = assemblePrompt({ kind: 'crossing', frames: 192, action: 'A wide shot begins in the position and framing established by Picture 1: a door.', sound: 'A door creaks.' });
  assert.ok(crossing.includes(`a door. ${LANDING}`));
  assert.ok(crossing.endsWith('overall_soundscape: A door creaks.\n\nnon_diegetic_music: N/A'));
  const loop = assemblePrompt({ kind: 'loop', frames: 192, action: 'A static shot holds the position and framing established by Picture 1: grass.', sound: 'Wind.' });
  assert.ok(loop.includes(LOOP_LANDING));
  const landed = assemblePrompt({ kind: 'crossing', frames: 192, action: `Something. ${LANDING}`, sound: 'Wind.' });
  assert.equal(landed.split(LANDING).length, 2);
});
