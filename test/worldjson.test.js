import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorld, mediaRefs, FORMAT } from '../cli/lib/worldjson.js';

const good = () => ({
  format: FORMAT,
  id: 'my-trip',
  title: 'My Trip',
  aspect: { width: 2304, height: 1536 },
  start: 'harbour',
  order: ['harbour', 'beach'],
  music: { src: 'audio/music.mp3', volume: 1, underFilms: 0.5, credit: 'Made with Sogni' },
  places: [
    {
      id: 'harbour', title: 'The Harbour', still: 'stills/harbour.jpg',
      loop: { src: 'films/harbour-loop.mp4', src720: 'films/harbour-loop-720.mp4', seconds: 8 },
      narration: { src: 'audio/narration-harbour.mp3', lines: [{ text: 'Hello.', start: 0.2, end: 1.1 }] },
      hotspots: [{
        id: 'ferry', label: 'Board the ferry', at: [0.6, 0.5], to: 'beach', next: true,
        outline: { width: 1536, height: 1024, path: 'M0 0L10 0L10 10Z' },
        film: { src: 'films/harbour-ferry.mp4', src720: 'films/harbour-ferry-720.mp4', seconds: 10.12 },
        rewind: { src: 'films/harbour-ferry-rewind.mp4' },
      }],
    },
    { id: 'beach', title: 'The Beach', still: 'stills/beach.jpg', loop: null, narration: null, music: { src: 'audio/music-beach.mp3', underFilms: 0 }, hotspots: [] },
  ],
});

test('a complete world is valid', () => {
  assert.deepEqual(validateWorld(good()), []);
});

test('every broken rule is reported', () => {
  const world = good();
  world.format = 'other';
  world.start = 'nowhere';
  world.order = ['harbour', 'moon'];
  world.places[0].hotspots[0].to = 'moon';
  world.places[0].hotspots[0].at = [1.2, 0.5];
  world.places[0].hotspots[0].shortcut = true;
  delete world.places[0].hotspots[0].film.src;
  world.places[0].surprise = true;
  world.places[1].music = { src: 'audio/music-beach.mp3', volume: 9 };
  world.places.push({ ...world.places[1] });
  const issues = validateWorld(world).join('\n');
  for (const expected of ['format must be', 'start: "nowhere"', 'order: "moon"', '.to: "moon"', '.at:', 'both the next stop and a shortcut', '.film.src: required', 'unknown field "surprise"', '"beach" appears twice', 'places[beach].music.volume: 0 to 4']) {
    assert.match(issues, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), expected);
  }
});

test('media references are every file the world plays', () => {
  const refs = mediaRefs(good());
  for (const ref of ['stills/harbour.jpg', 'films/harbour-loop-720.mp4', 'audio/narration-harbour.mp3', 'films/harbour-ferry-rewind.mp4', 'audio/music.mp3', 'audio/music-beach.mp3']) {
    assert.ok(refs.includes(ref), ref);
  }
});

test('an object may carry a details card: { title?, text, facts? }', () => {
  const world = good();
  world.places[0].hotspots[0].details = { title: 'The ferry', text: 'Twice a day to the island.', facts: [['Crossing', '40 minutes']] };
  assert.deepEqual(validateWorld(world), []);
  world.places[0].hotspots[0].details = { title: 'The ferry', facts: [['Crossing']], colour: 'blue' };
  const issues = validateWorld(world).join('\n');
  assert.match(issues, /details\.text/);
  assert.match(issues, /details\.facts/);
  assert.match(issues, /unknown field "colour"/);
});

test('a close look: a still, a film back, an optional spoken line; never on a crossing; its media ship with the world', async () => {
  const { mediaRefs } = await import('../cli/lib/worldjson.js');
  const reveal = { still: 'stills/a-glove.jpg', back: { src: 'films/a-glove-back.mp4', src720: 'films/a-glove-back-720.mp4' },
    narration: { src: 'audio/narration-a-glove.mp3', lines: [{ text: 'Blood on the palm.', start: 0.2, end: 1.4 }] }, done: 'Set it down' };
  const world = good();
  world.places[0].hotspots.push({ id: 'glove', label: 'Turn the glove over', at: [0.5, 0.8], film: { src: 'films/a-glove.mp4' }, reveal });
  assert.deepEqual(validateWorld(world), []);
  for (const ref of ['stills/a-glove.jpg', 'films/a-glove-back.mp4', 'films/a-glove-back-720.mp4', 'audio/narration-a-glove.mp3']) assert.ok(mediaRefs(world).includes(ref), ref);
  const broken = structuredClone(world);
  const glove = broken.places[0].hotspots.at(-1);
  delete glove.reveal.back;
  glove.to = 'beach';
  glove.reveal.extra = true;
  const issues = validateWorld(broken).join(' | ');
  for (const words of ['reveal.back', 'a crossing leaves', 'extra']) assert.ok(issues.includes(words), `${words}: ${issues}`);
});
