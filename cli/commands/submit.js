// Prepare a gallery listing. A person signs in and submits it in their browser.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readJson } from '../lib/files.js';
import { listWorlds, resolveWorldId, worldPaths } from '../lib/paths.js';
import { validateWorld } from '../lib/worldjson.js';
import { asDirectory, isPublicHttps } from '../lib/links.js';
import { SOCIAL } from '../lib/delivery.js';

export const summary = 'Prepare your hosted world for the public Sogni community gallery';
export const usage = `node world submit [world] --url https://your-world.example/ [--creator "Your name"] [--open]
       node world submit --url https://your-world.example/ --creator "Your name"
         [--title "…"] [--description "…"] [--cover https://…] [--scenes N] [--paths N]

  Build and host your export first. This prints a prefilled gallery submission
  link; --open also opens it. Sign in to Sogni, check the listing and submit.
  No API key is sent. Approval, feedback and withdrawal live in My worlds at
  worlds.sogni.ai. Your world stays on your host. Guide: docs/hosting.md

  A world built outside the Kit: leave out [world] (or name one that is not in
  worlds/). Its listing is read from the hosted page: og:title or <title>,
  og:description or the meta description, og:image as the cover and its
  canonical link; scene and path counts come from a world.json beside the page.
  Flags override what the page says. A count it cannot find, you type in the
  form. Sogni's gallery review checks every world.`;

const GALLERY_FORM = 'https://worlds.sogni.ai/submit-world';
const PUBLIC_LINK = 'Use the public HTTPS link where visitors play your world.';
/** Flags that describe a world built outside the Kit; a Kit world's listing comes from its build. */
const EXTERNAL_ONLY = ['title', 'description', 'cover', 'scenes', 'paths'];
/** Reading a hosted page: its tags are in the head, so a large page is read only this far. */
const PAGE_LIMIT = 2 * 1024 * 1024;
/** A world.json larger than this is not read (the Kit's own examples are under 1 MB). */
const MANIFEST_LIMIT = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Scenes and paths as the gallery lists them: every place, and every hotspot that goes somewhere. */
export function worldCounts(world) {
  const places = Array.isArray(world?.places) ? world.places : [];
  if (!places.length) return null;
  return { sceneCount: places.length,
    pathCount: places.reduce((sum, place) => sum + (Array.isArray(place?.hotspots) ? place.hotspots.filter(spot => spot?.to).length : 0), 0) };
}

/**
 * The prefilled gallery form. Its cover is the world's social card (`cover`,
 * a JPEG beside world.json: the gallery shows it, and crawlers read it where
 * they do not read WebP), or the opening still for a world built without one.
 */
export function submissionUrl(world, hostedUrl, creator, { cover = null } = {}) {
  const issues = validateWorld(world);
  if (issues.length) throw new Error(`Build a valid world before submitting: ${issues[0]}`);
  if (world.draft) throw new Error('Build the approved version of your world before submitting; this is a draft.');
  if (!isPublicHttps(new URL(hostedUrl))) throw new Error(PUBLIC_LINK);
  // Resolve media as the page's directory does, preserving a custom ?world= player input.
  const hosted = asDirectory(hostedUrl);
  const manifest = new URL(hosted.searchParams.get('world') || './world.json', hosted);
  const opening = world.places.find(place => place.id === world.start);
  const counts = worldCounts(world);
  const query = new URLSearchParams({ title: world.title, description: world.subtitle ?? '', url: hosted.href,
    coverUrl: new URL(cover ?? opening.still, manifest).href, creatorName: creator ?? world.credit ?? '',
    sceneCount: String(counts.sceneCount), pathCount: String(counts.pathCount) });
  return `${GALLERY_FORM}?${query}`;
}

/**
 * Which listing to prepare. A world in worlds/ is checked from its build; any
 * other world (no id, or an id with no folder here) is read from its hosted page.
 */
export function submissionMode(given, values = {}, worlds = listWorlds()) {
  if (!given || !worlds.includes(given)) return 'external';
  const extra = EXTERNAL_ONLY.find(key => values[key] !== undefined);
  if (extra) throw new Error(`--${extra} is for worlds built outside the Kit. The listing for "${given}" comes from its build: change world.yaml, then run node world build ${given}.`);
  return 'kit';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
const text = value => (value === undefined ? '' : decode(value).replace(/\s+/g, ' ').trim());
const TAG = /<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(source) {
  const found = {};
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTE)) {
    const key = name.toLowerCase();
    if (!(key in found)) found[key] = double ?? single ?? bare ?? '';
  }
  return found;
}

/**
 * What a hosted page says about itself: og:title (or <title>), og:description
 * (or the meta description), og:image and <link rel="canonical">, links
 * resolved against the page as a browser would. Scripts, styles and comments
 * are skipped, so a tag written inside one is never read.
 */
export function pageListing(html, pageUrl) {
  const doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const meta = {};
  let canonical;
  for (const [, tag, source] of doc.matchAll(TAG)) {
    const found = attributes(source);
    if (tag.toLowerCase() === 'meta') {
      if (found.content === undefined) continue;
      for (const key of [found.property, found.name]) if (key && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = found.content;
    } else if (canonical === undefined && found.href && (found.rel ?? '').toLowerCase().split(/\s+/).includes('canonical')) canonical = found.href;
  }
  const link = value => {
    const href = text(value);
    if (!href) return undefined;
    try { return new URL(href, pageUrl).href; } catch { return undefined; }
  };
  const ogTitle = text(meta['og:title']), ogDescription = text(meta['og:description']);
  const title = ogTitle || text(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc)?.[1]);
  const description = ogDescription || text(meta.description);
  return {
    title: title || undefined, titleFrom: ogTitle ? 'og:title' : '<title>',
    description: description || undefined, descriptionFrom: ogDescription ? 'og:description' : 'meta description',
    cover: link(meta['og:image']), canonical: link(canonical),
  };
}

/** GET a URL as text, reading at most `limit` bytes. Says whether it stopped short. */
async function fetchText(url, { fetch, timeoutMs, limit, accept }) {
  const response = await fetch(url, { redirect: 'follow', headers: { accept }, signal: AbortSignal.timeout(timeoutMs) });
  const finalUrl = response.url || url;
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, url: finalUrl };
  }
  const chunks = [];
  let size = 0, truncated = false;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { ok: true, status: response.status, url: finalUrl, truncated, body: new TextDecoder().decode(Buffer.concat(chunks)) };
}

const reason = error => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'no answer in time'
  : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error));

function wholeNumber(value, flag, min) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min) throw new Error(`--${flag} is a whole number, ${min} or more (got "${value}").`);
  return Number(value);
}

/**
 * The prefilled gallery form for a world built outside the Kit, read from its
 * hosted page. Nothing is uploaded and no key is sent: the page and a
 * world.json beside it are only read. Flags override what the page says.
 * Returns { url, fields, from } so the caller can say what came from where.
 */
export async function externalSubmission(hostedUrl, options = {}, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, pageLimit = PAGE_LIMIT, manifestLimit = MANIFEST_LIMIT } = {}) {
  let hosted;
  try { hosted = new URL(hostedUrl); } catch { throw new Error(PUBLIC_LINK); }
  if (!isPublicHttps(hosted)) throw new Error(PUBLIC_LINK);
  const scenes = wholeNumber(options.scenes, 'scenes', 1), paths = wholeNumber(options.paths, 'paths', 0);

  let page;
  try { page = await fetchText(hosted.href, { fetch, timeoutMs, limit: pageLimit, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' }); }
  catch (error) { throw new Error(`Could not load ${hosted.href} (${reason(error)}). Visitors must be able to open it without signing in.`); }
  if (!page.ok) throw new Error(`Could not load ${hosted.href} (HTTP ${page.status}). Visitors must be able to open it without signing in.`);
  const read = pageListing(page.body, page.url);

  const from = {};
  const pick = (key, given, found, source) => {
    if (given !== undefined) { from[key] = 'given'; return given; }
    if (found !== undefined) { from[key] = source; return found; }
    return undefined;
  };
  const title = pick('title', options.title?.trim() || undefined, read.title, read.titleFrom);
  if (!title) throw new Error(`${hosted.href} has no og:title or <title>. Pass the title: --title "Your world's name"`);
  const description = pick('description', options.description, read.description, read.descriptionFrom);
  const coverGiven = options.cover !== undefined;
  const cover = pick('cover', options.cover, read.cover, 'og:image');
  if (!cover) throw new Error(`${hosted.href} has no og:image. Pass a cover still: --cover https://your-world.example/cover.jpg`);
  let coverUrl;
  try { coverUrl = new URL(cover); } catch { coverUrl = null; }
  if (!coverUrl || !isPublicHttps(coverUrl)) {
    throw new Error(coverGiven ? 'Use a public HTTPS link for --cover.' : `The page's og:image (${cover}) is not a public HTTPS link. Pass a cover still: --cover https://…`);
  }
  let canonical = null;
  if (read.canonical) {
    try { canonical = new URL(read.canonical); } catch { canonical = null; }
    if (canonical && !isPublicHttps(canonical)) canonical = null;
  }
  const url = canonical?.href ?? hosted.href;
  from.url = canonical ? 'canonical link' : 'given';

  // Counts: a world.json beside the page, counted as the Kit counts its own builds.
  // Missing, unreadable or another format means the person types them in the form.
  let counted = null;
  if (scenes === undefined || paths === undefined) {
    const manifest = new URL('world.json', page.url).href;
    try {
      const response = await fetchText(manifest, { fetch, timeoutMs, limit: manifestLimit, accept: 'application/json' });
      if (response.ok && !response.truncated) counted = worldCounts(JSON.parse(response.body));
    } catch { counted = null; }
  }
  const sceneCount = scenes ?? counted?.sceneCount, pathCount = paths ?? counted?.pathCount;
  if (sceneCount !== undefined) from.sceneCount = scenes !== undefined ? 'given' : 'world.json';
  if (pathCount !== undefined) from.pathCount = paths !== undefined ? 'given' : 'world.json';

  const fields = { title, ...(description ? { description } : {}), url, coverUrl: coverUrl.href,
    ...(options.creator?.trim() ? { creatorName: options.creator.trim() } : {}),
    ...(sceneCount !== undefined ? { sceneCount: String(sceneCount) } : {}),
    ...(pathCount !== undefined ? { pathCount: String(pathCount) } : {}) };
  return { url: `${GALLERY_FORM}?${new URLSearchParams(fields)}`, fields, from };
}

const LABELS = { title: 'Title', description: 'Description', url: 'Link', coverUrl: 'Cover', creatorName: 'Creator', sceneCount: 'Scenes', pathCount: 'Paths' };
const SOURCE_KEY = { coverUrl: 'cover' };
const short = value => (value.length > 90 ? `${value.slice(0, 87)}…` : value);

async function runExternal(given, values) {
  if (given) log.dim(`No world "${given}" in worlds/: preparing it as a world built outside the Kit.`);
  else if (listWorlds().length) log.dim('Preparing a world built outside the Kit. For a world built here, name it so its build is checked first: node world submit <world> --url …');
  log.step(`Reading ${values.url}`);
  const { url, fields, from } = await externalSubmission(values.url, values);
  for (const [key, value] of Object.entries(fields)) {
    const source = from[SOURCE_KEY[key] ?? key];
    log.info(`${LABELS[key].padEnd(12)} ${short(value)}${source && source !== 'given' ? `  (${source})` : ''}`);
  }
  log.info('Open this link to check your listing, sign in and submit for gallery review:');
  console.log(url);
  // The form requires these; what the page could not tell us, the person types in.
  if (!fields.creatorName) log.info('Type your creator name in the form, or pass --creator "Your name".');
  const uncounted = [!fields.sceneCount && 'scenes', !fields.pathCount && 'paths'].filter(Boolean);
  if (uncounted.length) log.info(`Type the number of ${uncounted.join(' and ')} in the form: there is no world.json beside the page to count them from (or pass ${uncounted.map(name => `--${name} N`).join(' ')}).`);
  log.info('Your world stays on your host. Check decisions, resubmit updates or withdraw from My worlds at worlds.sogni.ai.');
  return url;
}

export async function run(argv) {
  const { values, world } = parse(argv, { url: { type: 'string' }, creator: { type: 'string' }, open: { type: 'boolean' },
    title: { type: 'string' }, description: { type: 'string' }, cover: { type: 'string' }, scenes: { type: 'string' }, paths: { type: 'string' } });
  if (!values.url) throw new Error('Host your world, then run: node world submit <world> --url https://your-world.example/');
  let url;
  if (submissionMode(world, values) === 'external') url = await runExternal(world, values);
  else {
    const id = resolveWorldId(world), file = join(worldPaths(id).build, 'world.json');
    if (!existsSync(file)) throw new Error(`Build your world first: node world build ${id}`);
    const cover = existsSync(join(worldPaths(id).build, SOCIAL.file)) ? SOCIAL.file : null;
    url = submissionUrl(readJson(file), values.url, values.creator, { cover });
    log.info('Open this link to check your listing, sign in and submit for gallery review:');
    console.log(url);
    log.info('Your world stays on your host. Check decisions, resubmit updates or withdraw from My worlds at worlds.sogni.ai.');
  }
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
