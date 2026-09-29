import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { lintDirection, lintPlan, throughLattice } from '../cli/lib/lint.js';

const good = {
  kind: 'crossing', frames: 243,
  action: 'Live-action, cinematic, a wide shot begins in the position and framing established by Picture 1: a red door stands open in a grassy hill. The camera glides forward through the doorway into a short earthen passage and out into a rainforest clearing.',
  sound: 'The door creaks on its hinges; boots scuff across flagstones and rain drips from the ferns.',
};
const rules = issues => issues.filter(i => i.level === 'error').map(i => i.rule);

test('a well-formed direction has no errors', () => {
  assert.deepEqual(rules(lintDirection(good)), []);
});

test('negations, capitals, timestamps, extra shots and fades are errors', () => {
  assert.ok(rules(lintDirection({ ...good, sound: 'Nothing but wind.' })).includes('negation'));
  assert.ok(rules(lintDirection({ ...good, action: `${good.action} A sign reads EXIT.` })).includes('capitals'));
  assert.ok(!rules(lintDirection({ ...good, action: `${good.action} A sign reads "EXIT".` })).includes('capitals'), 'lettering in quotes is fine');
  assert.ok(rules(lintDirection({ ...good, action: `${good.action} At 00:04.000 it turns.` })).includes('timestamps'));
  assert.ok(rules(lintDirection({ ...good, action: `${good.action} [Shot 2] A second shot.` })).includes('one-shot'));
  assert.ok(rules(lintDirection({ ...good, action: `${good.action} The clearing dissolves into the sea.` })).includes('transition'));
  assert.ok(rules(lintDirection({ ...good, action: good.action.replace('established by Picture 1', 'of the photo') })).includes('opening'));
});

test('music words: an error unless the film is about music; birdsong is ambience', () => {
  assert.ok(rules(lintDirection({ ...good, sound: 'Soft piano music plays.' })).includes('music'));
  assert.ok(!rules(lintDirection({ ...good, sound: 'A guitarist strums and the crowd is singing.' }, 'Stay for the song')).includes('music'));
  assert.ok(!rules(lintDirection({ ...good, sound: 'A tūī sings a gurgling phrase from the pines.' })).includes('music'));
});

test('bridge and tower routes are errors unless the structure is passed far off; allow records an exception', () => {
  assert.equal(throughLattice('The camera travels out over the long suspension bridge, high above its deck.').length, 1);
  assert.equal(throughLattice('The camera glides forward high above the valley, the swing bridge far below.').length, 0);
  const route = { ...good, action: `${good.action} The camera glides along the bridge between its towers.` };
  assert.ok(rules(lintDirection(route)).includes('lattice'));
  const allowed = lintDirection({ ...route, allow: { lattice: 'approved take' } });
  assert.deepEqual(rules(allowed), []);
  assert.ok(allowed.some(i => i.message.startsWith('allowed:')));
  assert.ok(rules(lintDirection({ ...good, allow: ['no-such-rule'] })).includes('allow'));
});

test('a loop must keep a static camera; frames must be on the grid', () => {
  assert.ok(rules(lintDirection({ ...good, kind: 'loop' })).includes('static'));
  assert.ok(rules(lintDirection({ ...good, frames: 200 })).includes('frames'));
});

test('plan structure: unknown destinations, duplicate ids and points outside the picture', () => {
  const plan = {
    id: 'trip', title: 'Trip', canvas: '1152x768', order: 'free', voices: {},
    places: [
      { id: 'a', still: 'stills/a.jpg', title: 'A', seen: 'x', objects: [
        { id: 'door', label: 'Go', at: [1.2, 0.5], goes: 'nowhere', film: good },
        { id: 'door', label: 'Again', at: [0.5, 0.5], film: good },
      ] },
    ],
  };
  const messages = lintPlan(plan, { dir: '/nonexistent' }, { checkFiles: false }).filter(f => f.level === 'error').map(f => f.message);
  assert.ok(messages.some(m => m.includes('"nowhere"')));
  assert.ok(messages.some(m => m.includes('share this id')));
  assert.ok(messages.some(m => m.includes('`at`')));
});

test('the example plan lints clean', () => {
  const file = new URL('../examples/the-long-white-cloud/world.yaml', import.meta.url);
  if (!existsSync(file)) return;
  const plan = parse(readFileSync(file, 'utf8'));
  for (const place of plan.places) place.objects ??= [];
  plan.voices ??= {};
  const errors = lintPlan(plan, { dir: '/nonexistent' }, { checkFiles: false }).filter(f => f.level === 'error');
  assert.deepEqual(errors, []);
});

test('findings name the field and quote the words that set them off', () => {
  const issues = lintDirection({ ...good, sound: 'Nothing but wind over the lake.' });
  const negation = issues.find(i => i.rule === 'negation');
  assert.equal(negation.field, 'sound');
  assert.match(negation.message, /"Nothing"/);
  const plan = { id: 'trip', title: 'T', canvas: '1152x768', order: 'free', voices: {},
    places: [{ id: 'a', still: 'stills/a.jpg', title: 'A', seen: 'x', objects: [{ id: 'door', label: 'Go', at: [0.5, 0.5], film: { ...good, sound: 'Nothing but wind.' } }] }] };
  const finding = lintPlan(plan, { dir: '/nonexistent' }, { checkFiles: false }).find(f => f.level === 'error');
  assert.equal(finding.where, 'films.a-door.sound');
});

test('a sound that fades is fine; a picture that fades or dissolves is not', () => {
  assert.ok(!rules(lintDirection({ ...good, kind: 'moment', action: good.action.replace('begins in', 'static wide shot holds'), sound: 'The rumble fades into the wind.' })).includes('transition'));
  const picture = lintDirection({ ...good, action: `${good.action} The clearing fades into the sea.` });
  assert.ok(rules(picture).includes('transition'));
  assert.match(picture.find(i => i.rule === 'transition').message, /"fades into"/);
});

test('plan paths must stay inside the world folder', () => {
  const plan = {
    id: 'trip', title: 'T', canvas: '1152x768', order: 'free',
    voices: { me: { clone: '../../../.ssh/id_rsa', transcript: 'x' } },
    music: { file: '/etc/passwd' },
    places: [{ id: 'a', still: '../a.jpg', title: 'A', seen: 'x', objects: [{ id: 'door', label: 'Go', at: [0.5, 0.5], film: { ...good, keyframes: [{ image: '/tmp/k.jpg', frame: 10 }] } }] }],
  };
  const outside = lintPlan(plan, { dir: '/worlds/trip' }, { checkFiles: false }).filter(f => /outside the world's folder/.test(f.message)).map(f => f.where);
  assert.deepEqual(outside.sort(), ['films.a-door.keyframes', 'music', 'places.a', 'voices.me'].sort());
});
