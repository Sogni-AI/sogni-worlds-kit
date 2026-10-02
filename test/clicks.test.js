import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clickCauses, lintDirection } from '../cli/lib/lint.js';
import { headNoun } from '../cli/lib/figures.js';
import { figureName } from '../cli/commands/build.js';
import { worldCredit } from '../cli/commands/agent.js';
import { mediaRefs, validateWorld, FORMAT } from '../cli/lib/worldjson.js';

const opening = 'Cinematic 3D rendered, a wide shot begins in the position and framing established by Picture 1: a small sloth stands on a path below a staircase lined with paper lanterns, a stone hand at right.';

test('a film that starts somewhere other than the clicked thing is flagged; one that starts with it is not', () => {
  const lantern = { id: 'paper-lantern', label: 'Follow the lanterns to the city', target: 'the glowing paper lantern floating low on the left' };
  const wrong = { action: `${opening} The sloth walks right toward the stone hand and slips into a crack in it. The camera follows it down a dark chute. At the bottom a lantern swings over a neon street.` };
  assert.match(clickCauses(lantern, wrong), /only comes in late/);
  const away = { action: `${opening} The sloth walks right toward the stone hand and slips into a crack in it. The camera follows it down a dark chute.` };
  assert.match(clickCauses(lantern, away), /never brings in/);
  const right = { action: `${opening} The nearest paper lantern lifts off and drifts up the staircase, and the sloth follows it. The camera rises after them.` };
  assert.equal(clickCauses(lantern, right), null);
});

test('the click check counts a person by any word for them, a word built on the clicked word, and a whole-picture object', () => {
  const singer = { id: 'leader', label: 'Stay for the song', target: 'the man leading the singing at centre' };
  assert.equal(clickCauses(singer, { action: `${opening} He raises his arms and the group begins to sing.` }), null);
  const falls = { id: 'falls', label: 'Follow the falls up' };
  assert.equal(clickCauses(falls, { action: `${opening} The camera tilts up along the waterfall to the cloud.` }), null);
  const cliff = { id: 'cliff', label: 'Step back from the view', select: { box: [0, 0.38, 1, 0.88] } };
  assert.equal(clickCauses(cliff, { action: `${opening} The camera pulls straight back and the picture becomes a screen.` }), null);
});

test('a direction cut off mid-sentence is an error', () => {
  const film = { frames: 192, action: `${opening} The magazine rack holds old magazines, one spine reading`, sound: 'Paper rustles.' };
  assert.ok(lintDirection(film).some(f => f.rule === 'unfinished' && f.level === 'error' && f.field === 'action'));
  const done = { ...film, action: `${opening} The top magazine slides out of the rack and flops open on the floor.` };
  assert.ok(!lintDirection(done).some(f => f.rule === 'unfinished'));
});

test('figures are named by the thing, and Pixal3D is told its head noun', () => {
  assert.equal(figureName('Touch the neon lotus'), 'The neon lotus');
  assert.equal(figureName('Simon'), 'Simon');
  assert.equal(headNoun('the ornate dark arched doorway floating in the sky, ringed by lanterns'), 'doorway');
  assert.equal(headNoun('a brass refracting telescope on a wooden tripod'), 'telescope');
  assert.equal(headNoun('the small pink flower in the moss near the hand'), 'flower');
});

test('world.json carries a figure, validates it, and exports its files', () => {
  const world = {
    format: FORMAT, id: 'w', title: 'W', aspect: { width: 16, height: 9 }, start: 'a',
    places: [{ id: 'a', title: 'A', still: 'stills/a.jpg', hotspots: [
      { id: 'lotus', label: 'Touch the lotus', at: [0.5, 0.5], collect: true, film: { src: 'films/a-lotus.mp4' }, figure: { model: 'figures/a-lotus.glb', icon: 'figures/a-lotus.png', name: 'The lotus' } },
    ] }],
  };
  assert.deepEqual(validateWorld(world), []);
  assert.ok(mediaRefs(world).includes('figures/a-lotus.glb') && mediaRefs(world).includes('figures/a-lotus.png'));
  world.places[0].hotspots[0].figure = { icon: 'x.png' };
  assert.ok(validateWorld(world).some(issue => /figure/.test(issue)));
});

test('the credit names the models that actually wrote, screened and pointed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credit-'));
  const logFile = join(dir, 'llm.jsonl');
  const call = (purpose, model) => JSON.stringify({ purpose, model });
  writeFileSync(logFile, [call('write-haka', 'candidate-writer'), call('review-haka', 'candidate-writer'), call('locate', 'qwen3.6-35b-a3b-gguf-iq4xs'),
    call('check-outline', 'candidate-writer'), call('judge-haka-t1', 'deepseek-v4-flash-vision-exp-dspark-1m')].join('\n'));
  const plan = { places: [{ id: 'haka', narration: { lines: ['Hi.'] }, objects: [] }] };
  const paths = { dir, audio: join(dir, 'audio') };
  const credit = worldCredit({ logFile, plan, paths, painted: false });
  assert.match(credit, /written by candidate-writer; retakes and screening by DeepSeek V4 Flash; objects found by Qwen 3\.6\./);
  assert.match(credit, /Films by MiniMax H3, voices by Qwen3-TTS, all on Sogni\./);
  writeFileSync(logFile, [call('write-haka', 'deepseek-v4-flash-vision-exp-dspark-1m'), call('judge-haka-t1', 'deepseek-v4-flash-vision-exp-dspark-1m')].join('\n'));
  assert.match(worldCredit({ logFile, plan, paths, painted: true }), /written and screened by DeepSeek V4 Flash\. Pictures by Krea 2/);
});
