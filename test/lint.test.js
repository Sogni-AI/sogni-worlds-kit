import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

test('the kit locks the camera of loops and moments: no other camera is accepted; frames must be on the grid', () => {
  // The kit writes the camera sentence itself, so a loop's direction no longer has to say "static".
  assert.deepEqual(rules(lintDirection({ ...good, kind: 'loop' })), []);
  assert.deepEqual(rules(lintDirection({ ...good, kind: 'loop', camera: 'locked' })), []);
  assert.ok(rules(lintDirection({ ...good, kind: 'loop', camera: 'sweep' })).includes('camera'));
  assert.deepEqual(rules(lintDirection({ ...good, kind: 'loop', allow: ['static'] })), [], 'an old plan that allowed the retired rule still lints');
  assert.ok(rules(lintDirection({ ...good, frames: 200 })).includes('frames'));
});

test('a loop or moment that turns a face away is a warning, never an error; a crossing is not checked', () => {
  const still = 'Live-action, cinematic, the camera holds still in the position and framing established by Picture 1: a woman stands by the lake.';
  const warned = action => lintDirection({ ...good, kind: 'loop', action }).filter(i => i.rule === 'face-turn');
  for (const turn of ['She turns her head away to the lake, then back.', 'She looks away across the water.', 'She glances over her shoulder.']) {
    const found = warned(`${still} ${turn}`);
    assert.equal(found.length, 1, turn);
    assert.equal(found[0].level, 'warn');
    assert.match(found[0].message, /breathing, a blink, hair in the wind, a slight smile/);
  }
  assert.deepEqual(warned(`${still} She breathes slowly and blinks; her hair lifts in the wind.`), []);
  assert.deepEqual(lintDirection({ ...good, action: `${good.action} A walker looks away.` }).filter(i => i.rule === 'face-turn'), []);
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

test('every example plan lints clean', () => {
  const examples = new URL('../examples/', import.meta.url);
  const names = existsSync(examples) ? readdirSync(examples).filter(name => existsSync(new URL(`${name}/world.yaml`, examples))) : [];
  assert.ok(names.includes('the-long-white-cloud') && names.includes('the-dream-thread'), 'both example worlds ship a plan');
  for (const name of names) {
    const plan = parse(readFileSync(new URL(`${name}/world.yaml`, examples), 'utf8'));
    for (const place of plan.places) place.objects ??= [];
    plan.voices ??= {};
    const errors = lintPlan(plan, { dir: '/nonexistent' }, { checkFiles: false }).filter(f => f.level === 'error');
    assert.deepEqual(errors, [], `examples/${name}/world.yaml`);
  }
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

test('a crossing between two stills of one view is warned about; one between places is not', async () => {
  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const sharp = (await import('sharp')).default;
  const { tempDir } = await import('./helpers.js');
  const { lintViews } = await import('../cli/lib/lint.js');
  const dir = tempDir('views');
  mkdirSync(join(dir, 'stills'));
  // A room: a window, a bed and a lamp, drawn as shapes. By night it is the same layout, darker and bluer.
  const room = (sky, wall) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="384" height="256"><rect width="384" height="256" fill="${wall}"/><rect x="40" y="30" width="140" height="110" fill="${sky}"/><rect x="200" y="150" width="160" height="70" fill="#8a6"/><rect x="230" y="60" width="14" height="90" fill="#ccc"/><circle cx="237" cy="55" r="20" fill="#fe8"/></svg>`);
  const street = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="384" height="256"><rect width="384" height="256" fill="#556"/><polygon points="0,256 160,90 224,90 384,256" fill="#333"/><rect x="300" y="20" width="60" height="200" fill="#a55"/><rect x="10" y="40" width="50" height="160" fill="#5a5"/></svg>');
  await sharp(room('#9cf', '#ddc')).jpeg().toFile(join(dir, 'stills', 'day.jpg'));
  await sharp(room('#124', '#334')).jpeg().toFile(join(dir, 'stills', 'night.jpg'));
  await sharp(street).jpeg().toFile(join(dir, 'stills', 'street.jpg'));
  const crossing = { film: { frames: 243, action: 'x', sound: 'y' } };
  const plan = { places: [
    { id: 'day', still: 'stills/day.jpg', objects: [{ id: 'blind', goes: 'night', ...crossing }, { id: 'door', goes: 'street', ...crossing }] },
    { id: 'night', still: 'stills/night.jpg', objects: [] },
    { id: 'street', still: 'stills/street.jpg', objects: [] },
  ] };
  const findings = await lintViews(plan, { dir });
  assert.deepEqual(findings.map(f => f.where), ['films.day-blind']);
  assert.equal(findings[0].level, 'warn');
});

test('a reveal: only on a moment, painted or described, its film back optional; a close look says or shows something', () => {
  const base = {
    id: 'w', title: 'W', canvas: '1344x768', order: 'free', voices: { narrator: { design: 'a low voice' } },
    places: [{ id: 'office', still: 'stills/office.jpg', title: 'Office', seen: 'An office.', narration: { voice: 'narrator', lines: ['Rain.'] }, objects: [] }],
  };
  const film = { frames: 141, action: good.action, sound: good.sound };
  const withObject = object => ({ ...base, places: [{ ...base.places[0], objects: [{ id: 'glove', label: 'Turn the glove over', at: [0.5, 0.8], film, ...object }] }] });
  const findings = plan => lintPlan(plan, { dir: '/nowhere' }, { checkFiles: false });
  const at = (list, level) => list.filter(f => f.level === level && f.where.includes('reveal')).map(f => f.message);

  const ok = findings(withObject({ reveal: { still: 'reveals/office-glove.jpg', seen: 'A hand holds the glove palm up; blood on the palm.', line: 'Blood on the palm.', back: film } }));
  assert.deepEqual(at(ok, 'error'), []);
  assert.deepEqual(at(ok, 'warn'), []);
  assert.ok(findings(withObject({ reveal: { still: 'reveals/office-glove.jpg', line: 'x', back: film } })).some(f => f.where.includes('reveal') && /write `seen`/.test(f.message)));
  assert.ok(at(findings(withObject({ reveal: { paint: 'A hand turns the glove over.', line: 'x', back: film } })), 'warn').some(m => /not painted yet/.test(m)));
  assert.ok(at(findings(withObject({ reveal: { line: 'x', back: film } })), 'error').some(m => /paint/.test(m)));
  // Without a written film back, build plays the film in backwards: no film back is needed.
  assert.deepEqual(at(findings(withObject({ reveal: { still: 'reveals/office-glove.jpg', seen: 's', line: 'x' } })), 'error'), []);
  assert.ok(at(findings(withObject({ reveal: { still: 'r.jpg', seen: 's', line: 'x', zoom: 5 } })), 'error').some(m => /zoom/.test(m)));
  assert.ok(at(findings(withObject({ goes: 'office', reveal: { still: 'r.jpg', seen: 's', back: film } })), 'error').some(m => /only a moment/.test(m)));
  assert.ok(at(findings(withObject({ reveal: { still: 'r.jpg', seen: 's', back: film } })), 'warn').some(m => /give it a `line`/.test(m)), 'a silent close look is a warning');
  assert.ok(at(findings(withObject({ reveal: { still: 'r.jpg', seen: 's', back: film, line: 'x', voice: 'stranger' } })), 'error').some(m => /not defined/.test(m)));
  // The film back is linted like every film.
  assert.ok(findings(withObject({ reveal: { still: 'r.jpg', seen: 's', line: 'x', back: { ...film, frames: 200 } } })).some(f => f.where === 'films.office-glove-back.frames'));
});
