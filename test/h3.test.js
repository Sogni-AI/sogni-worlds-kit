import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignmentLine, assemblePrompt, canvasFor, framesFor, isValidFrames, LANDING, LOCKED_CAMERA, LOOP_LANDING, PIXEL_BUDGET, CANVASES, VALID_FRAMES } from '../cli/lib/h3.js';

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

test('assemblePrompt ends on the landing sentence: the kit\'s, the film\'s own, or none', () => {
  const crossing = assemblePrompt({ kind: 'crossing', frames: 192, action: 'A wide shot begins in the position and framing established by Picture 1: a door.', sound: 'A door creaks.' });
  assert.ok(crossing.includes(`a door. ${LANDING}`));
  assert.ok(crossing.endsWith('overall_soundscape: A door creaks.\n\nnon_diegetic_music: N/A'));
  const loop = assemblePrompt({ kind: 'loop', frames: 192, action: 'A static shot holds the position and framing established by Picture 1: grass.', sound: 'Wind.' });
  assert.ok(loop.includes(LOOP_LANDING));
  // The landing says where the shot arrives, never that it slows down or settles.
  for (const sentence of [LANDING, LOOP_LANDING]) assert.doesNotMatch(sentence, /settl|slow|eas(e|ing)|gentl/i);
  const own = 'Still at full speed, the car bursts out of the tunnel into the framing of Picture 2.';
  const written = assemblePrompt({ kind: 'crossing', frames: 192, action: 'A wide shot begins in the position and framing established by Picture 1: a road.', landing: `  ${own}\n`, sound: 'Engine.' });
  assert.ok(written.includes(`a road. ${own}\n`) && !written.includes(LANDING), 'the film\'s own landing replaces the kit\'s');
  const none = assemblePrompt({ kind: 'moment', frames: 141, action: 'A static shot holds the position and framing established by Picture 1: grass.', landing: false, sound: 'Wind.' });
  assert.ok(none.includes('grass.\n') && !none.includes(LOOP_LANDING), 'landing: false adds nothing');
});

test('a direction written before `landing` existed, ending on the old landing words, keeps the exact prompt it had', () => {
  // The kit's landing sentences until 2026-11. Approved takes are never rendered again; these films also keep their words.
  const OLD = 'The camera settles into the pose, spacing and composition established by Picture 2 at the end of the shot.';
  const OLD_LOOP = 'The motion settles into the pose, spacing and composition established by Picture 2 at the end of the shot.';
  const opening = 'A wide shot begins in the position and framing established by Picture 1: a door.';
  for (const [kind, ending, camera] of [['crossing', OLD, ''], ['reveal', 'He turns to face the camera, settling into the pose, spacing, and composition established by Picture 2 at the end of the shot.', ''], ['loop', OLD_LOOP, `${LOCKED_CAMERA} `], ['moment', OLD_LOOP, `${LOCKED_CAMERA} `]]) {
    const prompt = assemblePrompt({ kind, frames: 192, action: `${opening}\n ${ending}`, sound: 'Wind.' });
    assert.ok(prompt.includes(`[Shot 1] ${camera}${opening} ${ending}\n\noverall_soundscape: Wind.`), kind);
    assert.ok(!prompt.includes(LANDING) && !prompt.includes(LOOP_LANDING), kind);
  }
});

test('every example film whose direction ends on the old landing words renders exactly as before', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const { filmsOf } = await import('../cli/lib/plan.js');
  for (const name of ['the-long-white-cloud', 'the-dream-thread']) {
    const plan = parse(readFileSync(new URL(`../examples/${name}/world.yaml`, import.meta.url), 'utf8'));
    for (const place of plan.places) place.objects ??= [];
    const films = filmsOf(plan).filter(film => /established by Picture 2/.test(film.action));
    assert.ok(films.length >= (name === 'the-long-white-cloud' ? 63 : 26), name);
    for (const film of films) {
      const flat = String(film.action).replace(/\s+/g, ' ').trim();
      const camera = ['loop', 'moment'].includes(film.kind) ? `${LOCKED_CAMERA} ` : '';
      assert.ok(assemblePrompt(film).includes(`[Shot 1] ${camera}${flat}\n\noverall_soundscape:`), `${name} ${film.id}`);
    }
  }
});

test('a loop or a moment says its two pictures are one photograph and holds a locked camera', async () => {
  const action = 'A static shot holds the position and framing established by Picture 1: grass.';
  const loop = assemblePrompt({ kind: 'loop', frames: 192, action, sound: 'Wind.' });
  assert.ok(loop.startsWith('How the reference pictures align with the target video — Picture 1 and Picture 2 are the same photograph.'));
  assert.ok(loop.includes(`[Shot 1] ${LOCKED_CAMERA} ${action}`), 'locked, before the direction');
  assert.ok(assemblePrompt({ kind: 'moment', frames: 141, action, sound: 'Wind.' }).includes(LOCKED_CAMERA));
  for (const kind of ['crossing', 'reveal', 'back']) {
    const prompt = assemblePrompt({ kind, frames: 141, action, sound: 'Wind.' });
    assert.ok(!prompt.includes('same photograph') && !prompt.includes(LOCKED_CAMERA) && prompt.includes(LANDING), kind);
  }
});

test('a loop or a moment may write its own camera in place of the locked one; `locked` is the default', () => {
  const action = 'A static shot holds the position and framing established by Picture 1: a stone bridge.';
  const camera = 'The camera shakes hard as the wall bursts, then comes back to the exact framing of Picture 1 by the last frame.';
  const moment = assemblePrompt({ kind: 'moment', frames: 141, action, camera: `${camera}\n`, sound: 'A roar.' });
  assert.ok(moment.includes(`[Shot 1] ${camera} ${action} ${LOOP_LANDING}`));
  assert.ok(!moment.includes(LOCKED_CAMERA));
  for (const keyword of ['locked', 'sweep', 'handheld']) {
    // A single word is not a camera sentence: `locked`, or a keyword an earlier kit knew, keeps the locked camera.
    assert.equal(assemblePrompt({ kind: 'loop', frames: 192, action, camera: keyword, sound: 'Wind.' }), assemblePrompt({ kind: 'loop', frames: 192, action, sound: 'Wind.' }), keyword);
  }
  // Only a film on one still takes the kit's camera sentence; a crossing's camera is in its action.
  assert.ok(!assemblePrompt({ kind: 'crossing', frames: 141, action, camera, sound: 'Wind.' }).includes(camera));
});
