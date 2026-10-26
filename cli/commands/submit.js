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
import { galleryIssues, galleryLength, LIMITS, linkProblem } from '../lib/gallery.js';
import { SOCIAL } from '../lib/delivery.js';

export const summary = 'Prepare your hosted world for the public Sogni community gallery';
export const usage = `node world submit [world] --url https://your-world.example/ [--creator "Your name"] [--preview https://…] [--open]
       node world submit --url https://your-world.example/ --creator "Your name"
         [--title "…"] [--description "…"] [--cover https://…] [--preview https://…] [--scenes N] [--paths N]

  Build and host your export first. This prints a prefilled gallery submission
  link; --open also opens it. Sign in to Sogni, check the listing and submit.
  No API key is sent. Approval, feedback and withdrawal live in My worlds at
  worlds.sogni.ai. Your world stays on your host. Guide: docs/hosting.md

  A world built outside the Kit: leave out [world] (or name one that is not in
  worlds/). Its listing is read from the hosted page: og:title or <title>,
  og:description or the meta description, og:image as the cover and its
  canonical link; scene and path counts come from a world.json beside the page.
  Flags override what the page says. A count it cannot find, you type in the
  form. Sogni's gallery review checks every world.

  --preview is the world's preview loop, a short silent MP4 the gallery plays
  on its card (docs/hosting.md › Preview loop); outside the Kit it defaults to
  the page's og:video. Either way, the listing is checked against the gallery's
  own rules (lengths, public HTTPS links) before the link is printed.`;

const GALLERY_FORM = 'https://worlds.sogni.ai/submit-world';
const PUBLIC_LINK = 'Use the public HTTPS link where visitors play your world.';
const ADD_PREVIEW = 'You can add a preview loop, a short silent MP4 that loops cleanly: --preview https://…/preview.mp4 (docs/hosting.md › Preview loop).';
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
export function submissionUrl(world, hostedUrl, creator, { cover = null, preview = null } = {}) {
  const issues = validateWorld(world);
  if (issues.length) throw new Error(`Build a valid world before submitting: ${issues[0]}`);
  if (world.draft) throw new Error('Build the approved version of your world before submitting; this is a draft.');
  if (!isPublicHttps(new URL(hostedUrl))) throw new Error(PUBLIC_LINK);
  // Resolve media as the page's directory does, preserving a custom ?world= player input.
  const hosted = asDirectory(hostedUrl);
  const manifest = new URL(hosted.searchParams.get('world') || './world.json', hosted);
  const opening = world.places.find(place => place.id === world.start);
  const counts = worldCounts(world);
  const fields = { title: world.title, description: world.subtitle ?? '', url: hosted.href,
    coverUrl: new URL(cover ?? opening.still, manifest).href, ...(preview ? { previewUrl: new URL(preview, manifest).href } : {}),
    creatorName: creator ?? world.credit ?? '',
    sceneCount: String(counts.sceneCount), pathCount: String(counts.pathCount) };
  const [issue] = galleryIssues(fields);
  if (issue) {
    const rebuild = `in world.yaml, then run node world build ${world.id}`;
    throw new Error({
      title: `The world's title ${issue.problem}. Change its title ${rebuild}.`,
      description: `The world's subtitle (the listing's description) ${issue.problem}. Change its subtitle ${rebuild}.`,
      creatorName: creator === undefined
        ? `The world's credit, the creator name when --creator is not given, ${issue.problem}. Pass your name: --creator "Your name".`
        : `The creator name ${issue.problem}. Pass a shorter one: --creator "Your name".`,
      url: `--url ${issue.problem}. ${PUBLIC_LINK}`,
      coverUrl: `The cover link (${fields.coverUrl}) ${issue.problem}. It is the world's social card or opening still: host it beside the world and pass that world's public link as --url.`,
      previewUrl: `The preview loop's link (${fields.previewUrl}) ${issue.problem}. Pass a public HTTPS link to an MP4: --preview https://….`,
    }[issue.field]);
  }
  return `${GALLERY_FORM}?${new URLSearchParams(fields)}`;
}

/** --preview: a public HTTPS link to an MP4, as the gallery takes it (absolute: never resolved against the page). */
export function givenPreview(value) {
  const problem = linkProblem(value) ?? (galleryLength(value) > LIMITS.previewUrl ? `is ${galleryLength(value).toLocaleString('en-US')} characters; the gallery takes at most ${LIMITS.previewUrl.toLocaleString('en-US')}` : null);
  if (problem) throw new Error(`--preview ${problem}. Use a public HTTPS link to an MP4 hosted next to your world.`);
  return new URL(value).href;
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

/** The og:video properties that name a video's link, in the order a link is taken from them. */
const VIDEO_LINKS = ['og:video:secure_url', 'og:video:url', 'og:video'];

/**
 * The page's preview loop from its og:video structures (each starts at an og:video tag; og:video:* tags after it
 * describe it): in each, the first HTTPS link of og:video:secure_url, og:video:url and og:video, resolved against the
 * page. A video typed video/mp4 is taken before an untyped one; one typed as anything else is not an MP4, so never.
 */
function pagePreview(videos, link) {
  const found = videos.map(video => {
    for (const key of VIDEO_LINKS) {
      const href = video[key] === undefined ? undefined : link(video[key]);
      if (href && new URL(href).protocol === 'https:') return { href, from: key, type: text(video['og:video:type']).toLowerCase().split(';')[0].trim() };
    }
    return null;
  }).filter(video => video && (!video.type || video.type === 'video/mp4'));
  return found.find(video => video.type === 'video/mp4') ?? found[0] ?? null;
}

/**
 * What a hosted page says about itself: og:title (or <title>), og:description
 * (or the meta description), og:image, og:video and <link rel="canonical">, links
 * resolved against the page as a browser would. Scripts, styles and comments
 * are skipped, so a tag written inside one is never read.
 */
export function pageListing(html, pageUrl) {
  const doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const meta = {}, videos = [];
  let canonical;
  for (const [, tag, source] of doc.matchAll(TAG)) {
    const found = attributes(source);
    if (tag.toLowerCase() === 'meta') {
      if (found.content === undefined) continue;
      for (const key of [found.property, found.name]) if (key && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = found.content;
      const key = (found.property ?? found.name ?? '').toLowerCase();
      if (key === 'og:video' || (key.startsWith('og:video:') && (!videos.length || key in videos.at(-1)))) videos.push({});
      if (key === 'og:video' || key.startsWith('og:video:')) videos.at(-1)[key] = found.content;
    } else if (canonical === undefined && found.href && (found.rel ?? '').toLowerCase().split(/\s+/).includes('canonical')) canonical = found.href;
  }
  const link = value => {
    const href = text(value);
    if (!href) return undefined;
    try { return new URL(href, pageUrl).href; } catch { return undefined; }
  };
  const preview = pagePreview(videos, link);
  const ogTitle = text(meta['og:title']), ogDescription = text(meta['og:description']);
  const title = ogTitle || text(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc)?.[1]);
  const description = ogDescription || text(meta.description);
  return {
    title: title || undefined, titleFrom: ogTitle ? 'og:title' : '<title>',
    description: description || undefined, descriptionFrom: ogDescription ? 'og:description' : 'meta description',
    cover: link(meta['og:image']), canonical: link(canonical),
    preview: preview?.href, previewFrom: preview?.from,
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
  const urlProblem = linkProblem(hostedUrl);
  if (urlProblem) throw new Error(`--url ${urlProblem}. ${PUBLIC_LINK}`);
  const hosted = new URL(hostedUrl);
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
  const coverProblem = linkProblem(cover);
  if (coverProblem) {
    throw new Error(coverGiven ? `--cover ${coverProblem}. Use a public HTTPS link to a still from your world.`
      : `The page's og:image (${cover}) ${coverProblem}. Pass a cover still: --cover https://…`);
  }
  const coverUrl = new URL(cover);
  // The page's canonical link is a default: one the gallery would not take is passed over for --url.
  const canonical = read.canonical && !linkProblem(read.canonical) && galleryLength(new URL(read.canonical).href) <= LIMITS.url ? new URL(read.canonical) : null;
  const url = canonical?.href ?? hosted.href;
  from.url = canonical ? 'canonical link' : 'given';

  // The preview loop is optional: --preview, or else the page's og:video. One the gallery would not take is given
  // back as an error; one read from the page is left out, and the person is told why.
  let previewUrl, previewNote = null;
  if (options.preview !== undefined) {
    previewUrl = givenPreview(options.preview);
    from.preview = 'given';
  } else if (read.preview) {
    const [issue] = galleryIssues({ previewUrl: read.preview });
    if (issue) previewNote = `The page's ${read.previewFrom} (${read.preview}) ${issue.problem}, so it is left out. ${ADD_PREVIEW}`;
    else { previewUrl = read.preview; from.preview = read.previewFrom; }
  }

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

  const fields = { title, ...(description ? { description } : {}), url, coverUrl: coverUrl.href, ...(previewUrl ? { previewUrl } : {}),
    ...(options.creator?.trim() ? { creatorName: options.creator.trim() } : {}),
    ...(sceneCount !== undefined ? { sceneCount: String(sceneCount) } : {}),
    ...(pathCount !== undefined ? { pathCount: String(pathCount) } : {}) };
  const [issue] = galleryIssues(fields);
  if (issue) {
    const source = from[issue.field === 'coverUrl' ? 'cover' : issue.field];
    const what = source && source !== 'given' ? `The page's ${source}` : { title: 'The title', description: 'The description',
      creatorName: 'The creator name', url: 'The link', coverUrl: 'The cover link' }[issue.field];
    throw new Error(`${what} ${issue.problem}. ${{ title: 'Pass a shorter title: --title "…"', description: 'Pass a shorter description: --description "…"',
      creatorName: 'Pass a shorter name: --creator "…"', url: 'Pass a shorter link: --url https://…', coverUrl: 'Pass a shorter cover link: --cover https://…' }[issue.field]}`);
  }
  return { url: `${GALLERY_FORM}?${new URLSearchParams(fields)}`, fields, from, previewNote };
}

const LABELS = { title: 'Title', description: 'Description', url: 'Link', coverUrl: 'Cover', previewUrl: 'Preview', creatorName: 'Creator', sceneCount: 'Scenes', pathCount: 'Paths' };
const SOURCE_KEY = { coverUrl: 'cover', previewUrl: 'preview' };
const short = value => (value.length > 90 ? `${value.slice(0, 87)}…` : value);

async function runExternal(given, values) {
  if (given) log.dim(`No world "${given}" in worlds/: preparing it as a world built outside the Kit.`);
  else if (listWorlds().length) log.dim('Preparing a world built outside the Kit. For a world built here, name it so its build is checked first: node world submit <world> --url …');
  log.step(`Reading ${values.url}`);
  const { url, fields, from, previewNote } = await externalSubmission(values.url, values);
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
  if (!fields.previewUrl) log.info(previewNote ?? `No preview loop (the page has no og:video MP4). ${ADD_PREVIEW}`);
  log.info('Your world stays on your host. Check decisions, resubmit updates or withdraw from My worlds at worlds.sogni.ai.');
  return url;
}

export async function run(argv) {
  const { values, world } = parse(argv, { url: { type: 'string' }, creator: { type: 'string' }, open: { type: 'boolean' },
    title: { type: 'string' }, description: { type: 'string' }, cover: { type: 'string' }, preview: { type: 'string' }, scenes: { type: 'string' }, paths: { type: 'string' } });
  if (!values.url) throw new Error('Host your world, then run: node world submit <world> --url https://your-world.example/');
  let url;
  if (submissionMode(world, values) === 'external') url = await runExternal(world, values);
  else {
    const id = resolveWorldId(world), file = join(worldPaths(id).build, 'world.json');
    if (!existsSync(file)) throw new Error(`Build your world first: node world build ${id}`);
    const cover = existsSync(join(worldPaths(id).build, SOCIAL.file)) ? SOCIAL.file : null;
    const preview = values.preview === undefined ? null : givenPreview(values.preview);
    url = submissionUrl(readJson(file), values.url, values.creator, { cover, preview });
    if (values.preview) log.info(`Preview loop: ${new URL(url).searchParams.get('previewUrl')}`);
    log.info('Open this link to check your listing, sign in and submit for gallery review:');
    console.log(url);
    if (!values.preview) log.info(`No preview loop. ${ADD_PREVIEW}`);
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
