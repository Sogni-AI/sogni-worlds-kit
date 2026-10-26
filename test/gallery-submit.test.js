import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { submissionUrl } from '../cli/commands/submit.js';

const world = JSON.parse(readFileSync(new URL('../examples/the-dream-thread/world.json', import.meta.url), 'utf8'));

test('a built Kit world produces a gallery form with credit, opening still and accurate counts', () => {
  const data = structuredClone(world);
  data.places[0].still = 'stills/opening.jpg';
  data.start = data.places[0].id;
  const url = new URL(submissionUrl(data, 'https://creator.example/my-world', 'A creator'));
  assert.equal(url.origin, 'https://worlds.sogni.ai');
  assert.equal(url.pathname, '/submit-world');
  assert.equal(url.searchParams.get('url'), 'https://creator.example/my-world/');
  assert.equal(url.searchParams.get('coverUrl'), 'https://creator.example/my-world/stills/opening.jpg');
  assert.equal(url.searchParams.get('creatorName'), 'A creator');
  assert.equal(url.searchParams.get('sceneCount'), String(data.places.length));
  assert.equal(url.searchParams.get('pathCount'), String(data.places.flatMap(place => place.hotspots).filter(spot => spot.to).length));
  assert.equal(url.searchParams.has('apiKey'), false);
});

test('the cover is the world\'s JPEG social card when the build made one', () => {
  const data = structuredClone(world);
  data.places[0].still = 'stills/opening.webp'; data.start = data.places[0].id;
  const url = new URL(submissionUrl(data, 'https://creator.example/my-world/', 'A creator', { cover: 'social.jpg' }));
  assert.equal(url.searchParams.get('coverUrl'), 'https://creator.example/my-world/social.jpg');
});

test('custom player manifest URLs and existing absolute media URLs resolve correctly', () => {
  const data = structuredClone(world);
  data.places[0].still = 'stills/opening.jpg'; data.start = data.places[0].id;
  const url = new URL(submissionUrl(data, 'https://creator.example/player/index.html?world=../../story/world.json'));
  assert.equal(url.searchParams.get('coverUrl'), 'https://creator.example/story/stills/opening.jpg');
  const absolute = world.places.find(place => place.id === world.start).still;
  assert.equal(new URL(submissionUrl(world, 'https://creator.example/')).searchParams.get('coverUrl'), absolute);
});

test('only approved builds and public HTTPS player links are prepared', () => {
  assert.throws(() => submissionUrl({ ...world, draft: true }, 'https://creator.example/'), /draft/);
  assert.throws(() => submissionUrl({ ...world, start: 'missing' }, 'https://creator.example/'), /valid world/);
  for (const url of ['http://creator.example/', 'https://name:password@creator.example/', 'javascript:alert(1)']) {
    assert.throws(() => submissionUrl(world, url), /HTTPS/);
  }
});
