// Prepare a gallery listing. A person signs in and submits it in their browser.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readJson } from '../lib/files.js';
import { resolveWorldId, worldPaths } from '../lib/paths.js';
import { validateWorld } from '../lib/worldjson.js';
import { SOCIAL } from '../lib/delivery.js';

export const summary = 'Prepare your hosted world for the public Sogni community gallery';
export const usage = `node world submit [world] --url https://your-world.example/ [--creator "Your name"] [--open]

  Build and host your export first. This prints a prefilled gallery submission
  link; --open also opens it. Sign in to Sogni, check the listing and submit.
  No API key is sent. Approval, feedback and withdrawal live in My worlds at
  worlds.sogni.ai. Your world stays on your host. Guide: docs/hosting.md`;

/**
 * The prefilled gallery form. Its cover is the world's social card (`cover`,
 * a JPEG beside world.json: the gallery shows it, and crawlers read it where
 * they do not read WebP), or the opening still for a world built without one.
 */
export function submissionUrl(world, hostedUrl, creator, { cover = null } = {}) {
  const issues = validateWorld(world);
  if (issues.length) throw new Error(`Build a valid world before submitting: ${issues[0]}`);
  if (world.draft) throw new Error('Build the approved version of your world before submitting; this is a draft.');
  const hosted = new URL(hostedUrl);
  if (hosted.protocol !== 'https:' || hosted.username || hosted.password) throw new Error('Use the public HTTPS link where visitors play your world.');
  // Static hosts may redirect a directory URL to add its slash. Resolve media
  // as that directory does, while preserving a custom ?world= player input.
  if (!hosted.pathname.endsWith('/') && !/\.[^/]+$/.test(hosted.pathname)) hosted.pathname += '/';
  const manifest = new URL(hosted.searchParams.get('world') || './world.json', hosted);
  const opening = world.places.find(place => place.id === world.start);
  const query = new URLSearchParams({ title: world.title, description: world.subtitle ?? '', url: hosted.href,
    coverUrl: new URL(cover ?? opening.still, manifest).href, creatorName: creator ?? world.credit ?? '',
    sceneCount: String(world.places.length), pathCount: String(world.places.reduce((sum, place) => sum + place.hotspots.filter(spot => spot.to).length, 0)) });
  return `https://worlds.sogni.ai/submit-world?${query}`;
}

export async function run(argv) {
  const { values, world } = parse(argv, { url: { type: 'string' }, creator: { type: 'string' }, open: { type: 'boolean' } });
  if (!values.url) throw new Error('Host your world, then run: node world submit <world> --url https://your-world.example/');
  const id = resolveWorldId(world), file = join(worldPaths(id).build, 'world.json');
  if (!existsSync(file)) throw new Error(`Build your world first: node world build ${id}`);
  const cover = existsSync(join(worldPaths(id).build, SOCIAL.file)) ? SOCIAL.file : null;
  const url = submissionUrl(readJson(file), values.url, values.creator, { cover });
  log.info('Open this link to check your listing, sign in and submit for gallery review:');
  console.log(url);
  log.info('Your world stays on your host. Check decisions, resubmit updates or withdraw from My worlds at worlds.sogni.ai.');
  if (values.open) {
    const [command, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore', shell: false });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Browser could not open (${code}). Use the link above.`)));
    });
  }
  return 0;
}
