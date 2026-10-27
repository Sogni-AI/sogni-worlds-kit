import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { exportWorld, hostWarnings, publicPage, withPreviewTags } from '../cli/commands/export.js';
import { pageListing, submissionUrl } from '../cli/commands/submit.js';
import { videoArgs } from '../cli/lib/delivery.js';
import { ffmpeg } from '../cli/lib/media.js';
import { previewLoop } from '../cli/lib/preview.js';
import { writeJson } from '../cli/lib/files.js';
import { pathsAt, tempDir } from './helpers.js';

const MiB = 1024 * 1024;
const out = join('/tmp', 'dist', 'harbour');
const file = (name, mib) => ({ path: join(out, name), size: mib * MiB });

test('export names every file a free host would refuse: Cloudflare Pages over 25 MiB, GitHub Pages over 100 MB', () => {
  assert.deepEqual(hostWarnings([file('index.html', 0.01), file('films/a.mp4', 25)], out), [], 'exactly 25 MiB is fine everywhere');
  const [cloudflare, ...rest] = hostWarnings([file('films/a.mp4', 24), file('films/b.mp4', 26.5)], out);
  assert.deepEqual(rest, []);
  assert.match(cloudflare, /^Cloudflare Pages refuses files over 25 MiB: films\/b\.mp4 \(26\.5 MB\)\. Use another host such as Netlify, or put those films on Cloudflare R2/);
  const both = hostWarnings([file('films/big.mp4', 120)], out);
  assert.equal(both.length, 2);
  assert.match(both[0], /^GitHub Pages refuses files over 100 MB: films\/big\.mp4 \(120\.0 MB\)/);
  assert.match(both[1], /^Cloudflare Pages refuses files over 25 MiB: films\/big\.mp4/);
  const site = hostWarnings(Array.from({ length: 50 }, (_, i) => file(`films/${i}.mp4`, 21)), out);
  assert.deepEqual(site.map(line => line.split(';')[0]), ['GitHub Pages sites are limited to about 1 GB']);
});

// Link previews: index.html names the world, its subtitle and its cover.
const built = { title: 'Ships & "Tides" <2>', subtitle: 'A harbour\'s day, dawn > dusk', start: 'quay', places: [{ id: 'quay', still: 'stills/quay.webp' }] };
const tag = (html, attr, name) => new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`).exec(html)?.[1];

test('the exported page carries the world\'s preview tags, every value escaped', () => {
  const html = withPreviewTags('<head>\n    <title>Sogni World</title>\n  </head>', built, { cover: 'social.jpg' });
  assert.ok(html.includes('<title>Ships &amp; &quot;Tides&quot; &lt;2&gt;</title>'));
  assert.ok(!html.includes('Sogni World'), 'the placeholder title is replaced');
  for (const [attr, name] of [['property', 'og:title'], ['name', 'twitter:title']]) assert.equal(tag(html, attr, name), 'Ships &amp; &quot;Tides&quot; &lt;2&gt;', name);
  for (const [attr, name] of [['name', 'description'], ['property', 'og:description'], ['name', 'twitter:description']]) assert.equal(tag(html, attr, name), 'A harbour&#39;s day, dawn &gt; dusk', name);
  assert.equal(tag(html, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(tag(html, 'name', 'twitter:player'), undefined);
  // A world with no subtitle has no description tags rather than empty ones.
  assert.equal(tag(withPreviewTags('<head></head>', { ...built, subtitle: undefined }, { cover: 'social.jpg' }), 'name', 'description'), undefined);
  assert.throws(() => withPreviewTags('<body></body>', built, { cover: 'social.jpg' }), /no <head>/);
});

test('without --url the cover is relative to the page; with it, absolute, and the page names its link', () => {
  const relative = withPreviewTags('<head><title>x</title></head>', built, { cover: 'social.jpg' });
  assert.equal(tag(relative, 'property', 'og:image'), 'social.jpg');
  assert.equal(tag(relative, 'name', 'twitter:image'), 'social.jpg');
  assert.equal(tag(relative, 'property', 'og:url'), undefined);
  const page = publicPage('https://creator.example/harbour');
  const absolute = withPreviewTags('<head><title>x</title></head>', built, { cover: 'social.jpg', url: page });
  assert.equal(tag(absolute, 'property', 'og:image'), 'https://creator.example/harbour/social.jpg');
  assert.equal(tag(absolute, 'name', 'twitter:image'), 'https://creator.example/harbour/social.jpg');
  assert.equal(tag(absolute, 'property', 'og:url'), 'https://creator.example/harbour/');
  assert.equal(tag(withPreviewTags('<head></head>', built, { cover: 'https://cdn.example/quay.webp', url: page }), 'property', 'og:image'), 'https://cdn.example/quay.webp', 'a streamed still keeps its own link');
  for (const url of ['http://creator.example/', 'https://me:secret@creator.example/', 'creator.example']) assert.throws(() => publicPage(url), /--url is the public HTTPS link/, url);
});

test('an exported world is read back by submit as itself: its real title, description and cover', async () => {
  const paths = pathsAt(tempDir('export-preview'), 'harbour');
  mkdirSync(join(paths.build, 'stills'), { recursive: true });
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).webp().toFile(join(paths.build, 'stills', 'quay.webp'));
  const world = { format: 'sogni-world@1', id: 'harbour', title: 'Harbour & Tides', subtitle: 'A day at the quay', credit: 'Me',
    aspect: { width: 192, height: 128 }, start: 'quay', places: [{ id: 'quay', title: 'Quay', still: 'stills/quay.webp', hotspots: [] }] };
  writeJson(join(paths.build, 'world.json'), world);
  const hosted = 'https://creator.example/harbour/';

  // Without a social card the cover is the opening still; without --url it is relative, and submit resolves it.
  const plain = join(tempDir('export-preview-out'), 'site');
  await exportWorld({ paths, out: plain });
  const read = pageListing(readFileSync(join(plain, 'index.html'), 'utf8'), hosted);
  assert.equal(read.title, 'Harbour & Tides');
  assert.equal(read.description, 'A day at the quay');
  assert.equal(read.cover, 'https://creator.example/harbour/stills/quay.webp');

  // With the build's social card and --url, the cover is the card, absolute.
  await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#335577' } }).jpeg().toFile(join(paths.build, 'social.jpg'));
  const linked = join(tempDir('export-preview-out'), 'site');
  await exportWorld({ paths, out: linked, url: publicPage('https://creator.example/harbour') });
  const html = readFileSync(join(linked, 'index.html'), 'utf8');
  assert.equal(tag(html, 'property', 'og:image'), 'https://creator.example/harbour/social.jpg');
  const card = pageListing(html, 'https://elsewhere.example/');
  assert.equal(card.title, 'Harbour & Tides');
  assert.equal(card.cover, 'https://creator.example/harbour/social.jpg', 'absolute, wherever the page is read from');
  assert.ok(html.includes('<script type="module"'), 'the player still loads');
  assert.equal(tag(html, 'name', 'twitter:card'), 'summary_large_image', 'a public URL alone is not a video card');
  assert.equal(existsSync(join(linked, 'preview/index.html')), false);
});

// The preview loop: export names the opening place's loop as og:video only when it qualifies.
const loopFilm = async (path, { width, height, seconds, seamless = true }) => {
  mkdirSync(dirname(path), { recursive: true });
  // Seamless: the film plays forward, then back, so it ends on its first frame. Otherwise a pan that never comes back.
  const source = seamless ? `testsrc2=size=${width}x${height}:rate=24:duration=${seconds / 2}` : `testsrc2=size=${width * 3}x${height}:rate=24:duration=${seconds},crop=${width}:${height}:x=t*${width / seconds}:y=0`;
  const graph = seamless ? '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]' : '[0:v]null[v]';
  await ffmpeg(['-f', 'lavfi', '-i', source, '-filter_complex', graph, '-map', '[v]', ...videoArgs({ width, height, fps: 24 }), '-an', path]);
};
async function builtWorld(name, films) {
  const paths = pathsAt(tempDir(`export-${name}`), 'harbour');
  mkdirSync(join(paths.build, 'stills'), { recursive: true });
  await sharp({ create: { width: 448, height: 256, channels: 3, background: '#335577' } }).webp().toFile(join(paths.build, 'stills', 'quay.webp'));
  const loop = {};
  for (const [key, spec] of Object.entries(films)) {
    loop[key] = `films/quay-loop${key === 'src720' ? '-720' : ''}.mp4`;
    await loopFilm(join(paths.build, loop[key]), spec);
  }
  writeJson(join(paths.build, 'world.json'), { format: 'sogni-world@1', id: 'harbour', title: 'Harbour', aspect: { width: 448, height: 256 }, start: 'quay',
    places: [{ id: 'quay', title: 'Quay', still: 'stills/quay.webp', ...(films.src ? { loop } : {}), hotspots: [] }] });
  return paths;
}
const sixteenNine = { width: 448, height: 256, seconds: 4 }; // the Kit's 16:9 canvas shape, 7:4

test('a seamless, 16:9 opening loop of 4 to 15 s is named as og:video, relative or absolute, and submit reads it back', async () => {
  const paths = await builtWorld('preview', { src: sixteenNine });
  const plain = join(tempDir('export-preview-plain'), 'site');
  const result = await exportWorld({ paths, out: plain });
  assert.deepEqual(result.preview.preview, { ref: 'films/quay-loop.mp4', width: 448, height: 256 });
  const html = readFileSync(join(plain, 'index.html'), 'utf8');
  assert.equal(tag(html, 'property', 'og:video'), 'films/quay-loop.mp4');
  assert.equal(tag(html, 'property', 'og:video:type'), 'video/mp4');
  assert.deepEqual([tag(html, 'property', 'og:video:width'), tag(html, 'property', 'og:video:height')], ['448', '256']);
  assert.equal(pageListing(html, 'https://creator.example/harbour/').preview, 'https://creator.example/harbour/films/quay-loop.mp4');
  assert.equal(tag(html, 'name', 'twitter:card'), 'summary_large_image', 'X needs a public HTTPS player URL');
  assert.equal(tag(html, 'name', 'twitter:player'), undefined);
  assert.equal(existsSync(join(plain, 'preview/index.html')), false);
  const linked = join(tempDir('export-preview-linked'), 'site');
  await exportWorld({ paths, out: linked, url: publicPage('https://creator.example/harbour') });
  const linkedHtml = readFileSync(join(linked, 'index.html'), 'utf8');
  const stream = 'https://creator.example/harbour/films/quay-loop.mp4';
  assert.equal(tag(linkedHtml, 'property', 'og:video'), stream);
  assert.equal(tag(linkedHtml, 'name', 'twitter:card'), 'player');
  assert.equal(tag(linkedHtml, 'name', 'twitter:player'), 'https://creator.example/harbour/preview/');
  assert.equal(tag(linkedHtml, 'name', 'twitter:player:stream'), stream);
  assert.equal(tag(linkedHtml, 'name', 'twitter:player:stream:content_type'), 'video/mp4');
  assert.deepEqual([tag(linkedHtml, 'name', 'twitter:player:width'), tag(linkedHtml, 'name', 'twitter:player:height')], ['448', '256']);
  const embed = readFileSync(join(linked, 'preview/index.html'), 'utf8');
  assert.ok(embed.includes(`<source src="${stream}" type="video/mp4">`), 'iframe plays the same qualified video as Open Graph');
  assert.match(embed, /controls autoplay muted loop playsinline/);
  assert.ok(embed.includes('poster="https://creator.example/harbour/stills/quay.webp"'), 'nested player resolves poster against the world root');
  assert.doesNotMatch(embed, /<script\b/, 'embedding the preview never starts the game');
  // Kit-mode submit lists the same film from the build, beside the world's public link.
  const { preview } = await previewLoop(JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8')), paths.build);
  const kit = submissionUrl(JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8')), 'https://creator.example/harbour', { preview: preview.ref });
  assert.equal(new URL(kit).searchParams.get('previewUrl'), 'https://creator.example/harbour/films/quay-loop.mp4');
  const withoutLoop = JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8'));
  delete withoutLoop.places[0].loop;
  writeJson(join(paths.build, 'world.json'), withoutLoop);
  await exportWorld({ paths, out: linked, url: publicPage('https://creator.example/harbour') });
  assert.equal(existsSync(join(linked, 'preview/index.html')), false, 're-exporting without a preview removes the old player');
  assert.equal(tag(readFileSync(join(linked, 'index.html'), 'utf8'), 'name', 'twitter:card'), 'summary_large_image');
});

test('no og:video for a loop that jumps, is not 16:9, is too short or is not in the Kit\'s film profile; the phone copy comes first', async () => {
  for (const [name, spec, why] of [
    ['jumps', { ...sixteenNine, seamless: false }, /does not end on its first frame/],
    ['three-two', { width: 384, height: 256, seconds: 4 }, /is 384×256, not 16:9/],
    ['short', { ...sixteenNine, seconds: 2 }, /runs 2\.0 s; a preview runs 4 to 15 s/],
  ]) {
    const paths = await builtWorld(name, { src: spec });
    const out = join(tempDir(`export-preview-${name}`), 'site');
    const result = await exportWorld({ paths, out, url: publicPage('https://creator.example/harbour') });
    assert.equal(result.preview.preview, null, name);
    assert.match(result.preview.why, why, name);
    assert.equal(tag(readFileSync(join(out, 'index.html'), 'utf8'), 'property', 'og:video'), undefined, `${name}: no og:video`);
    assert.equal(tag(readFileSync(join(out, 'index.html'), 'utf8'), 'name', 'twitter:card'), 'summary_large_image', name);
    assert.equal(existsSync(join(out, 'preview/index.html')), false, name);
  }
  const none = await builtWorld('none', {});
  assert.deepEqual(await previewLoop(JSON.parse(readFileSync(join(none.build, 'world.json'), 'utf8')), none.build), { preview: null, why: 'the opening place has no living-photo loop' });
  // A film from before the profile (index at the end) is never named, whatever it shows.
  const old = await builtWorld('old-profile', { src: sixteenNine });
  const film = join(old.build, 'films', 'quay-loop.mp4');
  await ffmpeg(['-i', film, '-c', 'copy', '-movflags', '-faststart', `${film}.tmp.mp4`]);
  renameSync(`${film}.tmp.mp4`, film);
  assert.match((await previewLoop(JSON.parse(readFileSync(join(old.build, 'world.json'), 'utf8')), old.build)).why, /not in the Kit's film profile/);
  // Both qualify: the phone copy, the smaller file, is the preview.
  const both = await builtWorld('both', { src: sixteenNine, src720: { width: 224, height: 128, seconds: 4 } });
  assert.equal((await previewLoop(JSON.parse(readFileSync(join(both.build, 'world.json'), 'utf8')), both.build)).preview.ref, 'films/quay-loop-720.mp4');
});
