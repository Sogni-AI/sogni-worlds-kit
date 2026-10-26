import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostWarnings } from '../cli/commands/export.js';

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
