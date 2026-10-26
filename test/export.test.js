import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { exportWorld, hostWarnings, publicPage, withPreviewTags } from '../cli/commands/export.js';
import { pageListing } from '../cli/commands/submit.js';
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
});
