import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { externalSubmission, givenPreview, pageListing, submissionMode, submissionUrl, worldCounts } from '../cli/commands/submit.js';
import { validateWorld } from '../cli/lib/worldjson.js';
import { galleryLength, linkProblem } from '../cli/lib/gallery.js';

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
  const url = new URL(submissionUrl(data, 'https://creator.example/player/index.html?world=../../story/world.json', 'A creator'));
  assert.equal(url.searchParams.get('coverUrl'), 'https://creator.example/story/stills/opening.jpg');
  const absolute = world.places.find(place => place.id === world.start).still;
  assert.equal(new URL(submissionUrl(world, 'https://creator.example/', 'A creator')).searchParams.get('coverUrl'), absolute);
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

// The gallery's own rules (worlds.sogni.ai SubmitKitWorldDto, externalWorldUrl, submitKit), checked before a link is printed.
test('lengths are measured as the gallery measures them: an emoji or a character with its variation selector counts once', () => {
  assert.equal(galleryLength('North Pole'), 10);
  assert.equal(galleryLength('🎄🦌'), 2, 'surrogate pairs count once');
  assert.equal(galleryLength('❤️ snow'), 6, 'a heart with its emoji selector counts once');
  assert.equal(galleryLength('️'), 1, 'a selector with nothing before it still counts');
});

test('the gallery takes public HTTPS names only: no IP address, localhost, .local, .internal, .test or .invalid', () => {
  assert.equal(linkProblem('https://natalieart.github.io/sogni-north-pole/'), null);
  for (const [url, problem] of [
    ['http://creator.example/', /not an HTTPS link/], ['https://me:pw@creator.example/', /name or password/], ['not a link', /not a link/],
    ['https://192.168.1.20/world/', /IP address/], ['https://[::1]/', /IP address/], ['https://intranet/', /no public name/],
    ['https://localhost/', /not a public name/], ['https://LOCALHOST:8443/', /not a public name/], ['https://me.localhost/', /not a public name/],
    ['https://box.local/', /not a public name/], ['https://api.internal/', /not a public name/], ['https://site.test/', /not a public name/], ['https://x.invalid/', /not a public name/],
  ]) assert.match(linkProblem(url) ?? 'accepted', problem, url);
  assert.equal(linkProblem('https://testing.example/'), null, 'only a whole label is reserved');
});

test('outside the Kit, a value the gallery would refuse fails before a link is printed, naming the field, its limit and the flag', async () => {
  const fetch = (pages = { [PAGE]: OG }) => ({ fetch: site(pages) });
  const at = (n, char = 'a') => char.repeat(n);
  assert.ok(await externalSubmission(PAGE, { title: at(120), description: at(1000), creator: at(80) }, fetch()));
  assert.ok(await externalSubmission(PAGE, { title: '🎄'.repeat(120) }, fetch()), '120 emoji are 240 code units, and the gallery takes them');
  await assert.rejects(externalSubmission(PAGE, { title: at(121) }, fetch()), /^Error: The title is 121 characters; the gallery takes at most 120\. Pass a shorter title: --title/);
  await assert.rejects(externalSubmission(PAGE, { description: at(1001) }, fetch()), /The description is 1,001 characters; the gallery takes at most 1,000\. Pass a shorter description: --description/);
  await assert.rejects(externalSubmission(PAGE, { creator: at(81) }, fetch()), /The creator name is 81 characters; the gallery takes at most 80\. Pass a shorter name: --creator/);
  // A long og:description is the page's, and --description replaces it.
  const longDescription = page(`<meta property="og:title" content="T"><meta property="og:image" content="og.jpg"><meta property="og:description" content="${at(1204)}">`);
  await assert.rejects(externalSubmission(PAGE, {}, fetch({ [PAGE]: longDescription })), /The page's og:description is 1,204 characters; the gallery takes at most 1,000\. Pass a shorter description: --description/);
  assert.ok(await externalSubmission(PAGE, { description: 'Short' }, fetch({ [PAGE]: longDescription })));
  const longTitle = page(`<title>${at(130)}</title><meta property="og:image" content="og.jpg">`);
  await assert.rejects(externalSubmission(PAGE, {}, fetch({ [PAGE]: longTitle })), /The page's <title> is 130 characters; .*--title/);
  // Links: the page's own link is checked before anything is fetched; a cover on a private name names --cover or og:image.
  for (const url of ['https://192.168.1.20/world/', 'https://localhost/world/', 'https://world.local/', 'https://intranet/']) {
    const calls = [];
    await assert.rejects(externalSubmission(url, {}, { fetch: site({}, calls) }), /^Error: --url .*HTTPS link where visitors play/, url);
    assert.deepEqual(calls, [], `${url} is never fetched`);
  }
  const noCanonical = page('<title>T</title><meta property="og:image" content="https://creator.example/og.jpg">');
  await assert.rejects(externalSubmission(`${PAGE}${at(2048)}`, {}, fetch({ [`${PAGE}${at(2048)}`]: noCanonical })), /The link is 2,\d{3} characters; the gallery takes at most 2,048\. Pass a shorter link: --url/);
  await assert.rejects(externalSubmission(PAGE, { cover: 'https://media.internal/cover.jpg' }, fetch()), /--cover is on media\.internal/);
  await assert.rejects(externalSubmission(PAGE, { cover: `https://cdn.example/${at(2048)}.jpg` }, fetch()), /The cover link is 2,\d{3} characters; .*--cover/);
  await assert.rejects(externalSubmission(PAGE, {}, fetch({ [PAGE]: page('<title>T</title><meta property="og:image" content="https://10.0.0.5/og.jpg">') })), /The page's og:image \(https:\/\/10\.0\.0\.5\/og\.jpg\) is an IP address.*--cover/);
  // A canonical link the gallery would not take is passed over for --url.
  const localCanonical = page('<title>T</title><meta property="og:image" content="og.jpg"><link rel="canonical" href="https://world.local/">');
  assert.equal(new URL((await externalSubmission(PAGE, {}, fetch({ [PAGE]: localCanonical }))).url).searchParams.get('url'), PAGE);
  // Counts: whole numbers, at least one scene and no fewer than no paths.
  await assert.rejects(externalSubmission(PAGE, { paths: '-1' }, fetch()), /--paths is a whole number, 0 or more/);
  await assert.rejects(externalSubmission(PAGE, { scenes: '2.5' }, fetch()), /--scenes is a whole number, 1 or more/);
});

test('a Kit world the gallery would refuse fails before a link is printed, saying what to change', () => {
  const at = n => 'a'.repeat(n);
  assert.ok(submissionUrl({ ...world, title: at(120), subtitle: at(1000) }, PAGE, at(80)));
  assert.throws(() => submissionUrl({ ...world, title: at(121) }, PAGE, 'N'), /The world's title is 121 characters; the gallery takes at most 120\. Change its title in world\.yaml, then run node world build the-dream-thread/);
  assert.throws(() => submissionUrl({ ...world, subtitle: at(1001) }, PAGE, 'N'), /The world's subtitle \(the listing's description\) is 1,001 characters; .* Change its subtitle in world\.yaml/);
  // A Kit world's credit is its About panel's line: often far longer than a name.
  assert.throws(() => submissionUrl(world, PAGE), /The world's credit, the creator name when --creator is not given, is 521 characters; the gallery takes at most 80\. Pass your name: --creator/);
  assert.throws(() => submissionUrl(world, PAGE, at(81)), /The creator name is 81 characters; .*--creator/);
  assert.throws(() => submissionUrl(world, PAGE, '   '), /The creator name is blank/);
  for (const url of ['https://localhost/world/', 'https://203.0.113.9/', 'https://world.test/']) assert.throws(() => submissionUrl(world, url, 'N'), /^Error: --url .*HTTPS link where visitors play/, url);
});

// The preview loop: --preview, or the page's og:video, listed as previewUrl.
const video = (key, content) => `<meta property="${key}" content="${content}">`;
const withVideo = tags => page(`<title>T</title><meta property="og:image" content="og.jpg">${tags}`);

test('the page\'s og:video gives the preview loop: secure_url, then url, then og:video, the first HTTPS one, resolved against the page', () => {
  const read = tags => pageListing(withVideo(tags), PAGE);
  assert.deepEqual([read(video('og:video', 'loop.mp4')).preview, read(video('og:video', 'loop.mp4')).previewFrom], [`${PAGE}loop.mp4`, 'og:video']);
  assert.equal(read(video('og:video', '/media/loop.mp4')).preview, 'https://creator.example/media/loop.mp4');
  const all = video('og:video', 'https://a.example/v.mp4') + video('og:video:url', 'https://b.example/v.mp4') + video('og:video:secure_url', 'https://c.example/v.mp4');
  assert.deepEqual([read(all).preview, read(all).previewFrom], ['https://c.example/v.mp4', 'og:video:secure_url']);
  assert.equal(read(video('og:video', 'https://a.example/v.mp4') + video('og:video:url', 'https://b.example/v.mp4')).preview, 'https://b.example/v.mp4');
  // A link that is not HTTPS is passed over for the next one, and with none the page has no preview.
  assert.equal(read(video('og:video', 'https://a.example/v.mp4') + video('og:video:secure_url', 'http://c.example/v.mp4')).preview, 'https://a.example/v.mp4');
  assert.equal(read(video('og:video', 'http://creator.example/v.mp4')).preview, undefined);
  assert.equal(read('').preview, undefined);
  // Several videos: one typed video/mp4 first; one typed as anything else is not an MP4.
  const several = video('og:video', 'https://a.example/v.webm') + video('og:video:type', 'video/webm')
    + video('og:video', 'https://a.example/v') + video('og:video', 'https://a.example/v.mp4') + video('og:video:type', 'video/mp4; codecs="avc1"');
  assert.equal(read(several).preview, 'https://a.example/v.mp4');
  assert.equal(read(video('og:video', 'https://a.example/v.webm') + video('og:video:type', 'video/webm') + video('og:video', 'https://a.example/plain')).preview, 'https://a.example/plain');
  assert.equal(read(video('og:video', 'https://player.example/embed') + video('og:video:type', 'text/html')).preview, undefined);
  // Structures that use only og:video:url still separate: a second :url starts the next video.
  assert.equal(read(video('og:video:url', 'https://a.example/1.mp4') + video('og:video:type', 'video/webm') + video('og:video:url', 'https://a.example/2.mp4') + video('og:video:type', 'video/mp4')).preview, 'https://a.example/2.mp4');
  assert.equal(read(`<!-- ${video('og:video', 'https://a.example/hidden.mp4')} -->`).preview, undefined, 'never from a comment');
});

test('outside the Kit the link carries previewUrl from og:video or --preview, and the summary says where it came from', async () => {
  const pages = { [PAGE]: withVideo(video('og:video:secure_url', 'films/preview.mp4') + video('og:video:type', 'video/mp4')) };
  const listed = await externalSubmission(PAGE, { creator: 'N' }, { fetch: site(pages) });
  assert.equal(new URL(listed.url).searchParams.get('previewUrl'), `${PAGE}films/preview.mp4`);
  assert.equal(listed.from.preview, 'og:video:secure_url');
  const given = await externalSubmission(PAGE, { preview: 'https://cdn.example/teaser.mp4' }, { fetch: site(pages) });
  assert.equal(new URL(given.url).searchParams.get('previewUrl'), 'https://cdn.example/teaser.mp4', '--preview overrides the page');
  assert.equal(given.from.preview, 'given');
  const none = await externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: withVideo('') }) });
  assert.equal(new URL(none.url).searchParams.has('previewUrl'), false, 'no preview is fine');
  assert.equal(none.previewNote, null);
  // One on a name the gallery would not take is left out, and the person is told why.
  const local = await externalSubmission(PAGE, {}, { fetch: site({ [PAGE]: withVideo(video('og:video', 'https://media.local/loop.mp4')) }) });
  assert.equal(new URL(local.url).searchParams.has('previewUrl'), false);
  assert.match(local.previewNote, /The page's og:video \(https:\/\/media\.local\/loop\.mp4\) is on media\.local.*left out.*--preview/);
});

test('--preview is a public HTTPS link to an MP4, as the gallery takes it, in both modes', async () => {
  for (const [value, problem] of [['http://creator.example/p.mp4', /not an HTTPS link/], ['https://me:pw@creator.example/p.mp4', /name or password/],
    ['https://10.1.2.3/p.mp4', /IP address/], ['https://localhost/p.mp4', /not a public name/], ['preview.mp4', /not a link/], ['', /not a link/],
    [`https://creator.example/${'p'.repeat(2048)}.mp4`, /characters; the gallery takes at most 2,048/]]) {
    assert.throws(() => givenPreview(value), problem, value);
    await assert.rejects(externalSubmission(PAGE, { preview: value }, { fetch: site({ [PAGE]: OG }) }), new RegExp(`^Error: --preview .*${problem.source}`), value);
  }
  assert.equal(givenPreview('https://creator.example/preview.mp4'), 'https://creator.example/preview.mp4');
  // A Kit world's link carries it too, after its cover.
  const kit = new URL(submissionUrl(world, PAGE, 'N', { preview: 'https://creator.example/north-pole/preview.mp4' }));
  assert.equal(kit.searchParams.get('previewUrl'), 'https://creator.example/north-pole/preview.mp4');
  assert.deepEqual([...kit.searchParams.keys()], ['title', 'description', 'url', 'coverUrl', 'previewUrl', 'creatorName', 'sceneCount', 'pathCount']);
  assert.equal(new URL(submissionUrl(world, PAGE, 'N')).searchParams.has('previewUrl'), false, 'and without one the link is as before');
});
