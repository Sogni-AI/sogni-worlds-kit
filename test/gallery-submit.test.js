import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { externalSubmission, submissionMode, submissionUrl, worldCounts } from '../cli/commands/submit.js';
import { validateWorld } from '../cli/lib/worldjson.js';

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

// Worlds built outside the Kit: the listing is read from the hosted page. No network here: fetch is a stub.
const PAGE = 'https://creator.example/north-pole/';
const site = (pages, calls = []) => async (url, init) => {
  calls.push(url);
  const entry = pages[url];
  if (entry instanceof Error) throw entry;
  if (entry === undefined) return new Response('<title>Page not found</title>', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(entry, { status: 200, headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'text/html' } });
};
const page = head => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><main></main></body></html>`;
const OG = page(`<title>Plain title</title>
  <meta name="description" content="Plain description">
  <meta property="og:title" content="The North Pole, a Sogni World">
  <meta property="og:description" content="Gingerbread, elves &amp; northern lights">
  <meta property="og:image" content="og.jpg">
  <link rel="canonical" href="https://creator.example/north-pole/">`);

test('a world built outside the Kit is listed from its page: og tags, a relative og:image and its canonical link', async () => {
  const calls = [];
  const { url, from } = await externalSubmission('https://creator.example/north-pole/index.html', { creator: 'NatalieArt' }, { fetch: site({ 'https://creator.example/north-pole/index.html': OG }, calls) });
  const form = new URL(url);
  assert.equal(form.origin + form.pathname, 'https://worlds.sogni.ai/submit-world');
  assert.equal(form.searchParams.get('title'), 'The North Pole, a Sogni World');
  assert.equal(form.searchParams.get('description'), 'Gingerbread, elves & northern lights');
  assert.equal(form.searchParams.get('coverUrl'), 'https://creator.example/north-pole/og.jpg');
  assert.equal(form.searchParams.get('url'), PAGE, 'the canonical link, not the index.html it was read from');
  assert.equal(form.searchParams.get('creatorName'), 'NatalieArt');
  assert.deepEqual([...form.searchParams.keys()], ['title', 'description', 'url', 'coverUrl', 'creatorName'], 'no counts it could not find, and no key');
  assert.equal(from.url, 'canonical link');
  assert.deepEqual(calls, ['https://creator.example/north-pole/index.html', 'https://creator.example/north-pole/world.json'], 'only the page and a world.json beside it are read');
});

test('without og tags it falls back to <title> and the meta description; tags in scripts and comments are never read', async () => {
  const html = page(`<!-- <meta property="og:title" content="Commented out"> -->
    <script>document.head.insertAdjacentHTML('beforeend', '<meta property="og:title" content="From a script">')</script>
    <title>  The   North Pole  </title><meta name="description" content="A world of &#8220;snow&#x201D;"><meta property="og:image" content="/media/cover.jpg">`);
  const form = new URL((await externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: html }) })).url);
  assert.equal(form.searchParams.get('title'), 'The North Pole');
  assert.equal(form.searchParams.get('description'), 'A world of “snow”');
  assert.equal(form.searchParams.get('coverUrl'), 'https://creator.example/media/cover.jpg');
  assert.equal(form.searchParams.get('url'), PAGE);
  assert.equal(form.searchParams.has('creatorName'), false, 'the person types their credit');
});

test('flags override what the page says, and with both counts given no world.json is read', async () => {
  const calls = [];
  const { url, from } = await externalSubmission(PAGE, { title: 'My title', description: 'Mine', cover: 'https://cdn.example/cover.jpg', scenes: '12', paths: '0', creator: 'N' },
    { fetch: site({ [PAGE]: OG }, calls) });
  const form = new URL(url);
  assert.equal(form.searchParams.get('title'), 'My title');
  assert.equal(form.searchParams.get('description'), 'Mine');
  assert.equal(form.searchParams.get('coverUrl'), 'https://cdn.example/cover.jpg');
  assert.equal(form.searchParams.get('sceneCount'), '12');
  assert.equal(form.searchParams.get('pathCount'), '0');
  assert.deepEqual(calls, [PAGE]);
  assert.equal(from.title, 'given');
  await assert.rejects(externalSubmission(PAGE, { scenes: '0' }, { fetch: site({ [PAGE]: OG }) }), /--scenes/);
  await assert.rejects(externalSubmission(PAGE, { paths: 'two' }, { fetch: site({ [PAGE]: OG }) }), /--paths/);
});

test('a world.json beside the page gives the counts, counted as the Kit counts its builds, even when it is not sogni-world@1', async () => {
  const custom = { format: 'north-pole-player', draft: true, places: [
    { id: 'cottage', hotspots: [{ type: 'door', to: 'workshop', glow: 'warm' }, { type: 'gift', reveal: 'box' }] },
    { id: 'workshop', hotspots: [{ type: 'door', to: 'cottage' }, { type: 'sleigh', to: 'moon' }] },
    { id: 'moon' },
  ] };
  assert.ok(validateWorld(custom).length, 'the Kit schema would reject it');
  const form = new URL((await externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: OG, [`${PAGE}world.json`]: JSON.stringify(custom) }) })).url);
  assert.equal(form.searchParams.get('sceneCount'), '3');
  assert.equal(form.searchParams.get('pathCount'), '3');
  const kit = structuredClone(world);
  assert.deepEqual(worldCounts(kit), { sceneCount: kit.places.length, pathCount: kit.places.flatMap(place => place.hotspots).filter(spot => spot.to).length });
  // One count given, the other from world.json.
  const mixed = new URL((await externalSubmission(PAGE, { scenes: '5' }, { fetch: site({ [PAGE]: OG, [`${PAGE}world.json`]: JSON.stringify(custom) }) })).url);
  assert.equal(mixed.searchParams.get('sceneCount'), '5');
  assert.equal(mixed.searchParams.get('pathCount'), '3');
});

test('a missing, unreadable or oversized world.json leaves the counts for the person to type, never fails', async () => {
  for (const [name, manifest, limits] of [
    ['missing', undefined, {}],
    ['an HTML fallback page', '<!doctype html><title>App</title>', {}],
    ['no places', JSON.stringify({ scenes: 4 }), {}],
    ['unreachable', new TypeError('fetch failed'), {}],
    ['over the size cap', JSON.stringify({ places: [{ hotspots: [] }], padding: 'x'.repeat(500) }), { manifestLimit: 100 }],
  ]) {
    const pages = { [PAGE]: OG, ...(manifest === undefined ? {} : { [`${PAGE}world.json`]: manifest }) };
    const form = new URL((await externalSubmission(PAGE, { creator: 'N' }, { fetch: site(pages), ...limits })).url);
    assert.equal(form.searchParams.has('sceneCount'), false, name);
    assert.equal(form.searchParams.has('pathCount'), false, name);
  }
});

test('only public HTTPS links are read or listed: the page, its cover and its canonical link', async () => {
  for (const url of ['http://creator.example/', 'https://name:password@creator.example/', 'javascript:alert(1)', 'not a link']) {
    const calls = [];
    await assert.rejects(externalSubmission(url, {}, { fetch: site({}, calls) }), /HTTPS/, url);
    assert.deepEqual(calls, [], `${url} is never fetched`);
  }
  await assert.rejects(externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: page('<title>T</title><meta property="og:image" content="http://creator.example/og.jpg">') }) }), /og:image.*--cover/);
  await assert.rejects(externalSubmission(PAGE, { cover: 'https://me:secret@creator.example/og.jpg' }, { fetch: site({ [PAGE]: OG }) }), /--cover/);
  const insecureCanonical = page('<title>T</title><meta property="og:image" content="og.jpg"><link rel="canonical" href="http://creator.example/north-pole/">');
  assert.equal(new URL((await externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: insecureCanonical }) })).url).searchParams.get('url'), PAGE);
});

test('a page with no title or cover, or one that does not load, fails and names what to pass', async () => {
  await assert.rejects(externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: page('<meta property="og:image" content="og.jpg">') }) }), /--title/);
  await assert.rejects(externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: page('<title>T</title>') }) }), /--cover/);
  await assert.rejects(externalSubmission(PAGE, {}, { fetch: site({}) }), /HTTP 404/);
  // A host that never answers. The open timer stands in for the socket a real request holds open.
  const hangs = (url, init) => new Promise((resolve, reject) => {
    const socket = setTimeout(() => {}, 5000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  await assert.rejects(externalSubmission(PAGE, {}, { fetch: hangs, timeoutMs: 20 }), /no answer in time/);
  // A large page is read only up to its cap: an og:image past it is not seen.
  const late = page(`<title>T</title>${' '.repeat(400)}<meta property="og:image" content="og.jpg">`);
  await assert.rejects(externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: late }), pageLimit: 200 }), /--cover/);
});

test('a world in worlds/ is checked from its build; anything else is read from its hosted page', () => {
  assert.equal(submissionMode('north-pole', {}, ['harbour']), 'external');
  assert.equal(submissionMode(undefined, {}, ['harbour']), 'external');
  assert.equal(submissionMode(undefined, {}, []), 'external');
  assert.equal(submissionMode('harbour', { url: PAGE, creator: 'N' }, ['harbour']), 'kit');
  assert.throws(() => submissionMode('harbour', { title: 'Other' }, ['harbour']), /--title is for worlds built outside the Kit/);
  // Kit worlds still pass the schema and the draft check before a link is made.
  assert.throws(() => submissionUrl({ ...world, draft: true }, PAGE), /draft/);
  assert.throws(() => submissionUrl({ ...world, places: [] }, PAGE), /valid world/);
});
