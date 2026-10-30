// export: a folder you can put on any static host.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { gather, nextStep } from './status.js';
import { ROOT, resolveWorldId, worldPaths, shown } from '../lib/paths.js';
import { readJson } from '../lib/files.js';
import { validateWorld, mediaRefs, isRemote } from '../lib/worldjson.js';
import { deliveryIssues, strayPngs, SOCIAL, DELIVERY_FIX } from '../lib/delivery.js';
import { runVite } from '../lib/player.js';
import { asDirectory, isPublicHttps } from '../lib/links.js';
import { previewLoop } from '../lib/preview.js';

export const summary = 'Export a finished world as a static site for any host';
export const usage = `node world export [world] [--out dist/<world>] [--url https://your-world.example/]

  Checks that every film, still and sound build/world.json plays is in the web
  formats (WebP stills, films through Sogni's streaming profile, PNG only for
  icons) and stops if one is not. Then builds the player and copies the world,
  its media and its social card next to index.html. The folder works on GitHub
  Pages, Netlify, Vercel, Cloudflare Pages, S3 — anything that serves files.

  index.html carries the world's link-preview tags (title, description, cover,
  and the opening place's loop as og:video when it can be the world's preview
  loop). With --url, a qualifying loop also gets an X video card and its own
  embedded player. --url makes the links absolute, as social sites and chat
  apps need. Guide: docs/hosting.md`;

const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const GITHUB_SITE_LIMIT = 1024 * 1024 * 1024;
const CLOUDFLARE_FILE_LIMIT = 25 * 1024 * 1024;

/** What the free hosts will refuse in an exported folder: one line per limit it crosses. */
export function hostWarnings(files, out) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const named = list => list.map(f => `${relative(out, f.path)} (${mb(f.size)})`).join(', ');
  const warnings = [];
  const overGithub = files.filter(file => file.size > GITHUB_FILE_LIMIT);
  if (overGithub.length) warnings.push(`GitHub Pages refuses files over 100 MB: ${named(overGithub)}. Use another host for those, or shorten the film.`);
  if (total > GITHUB_SITE_LIMIT) warnings.push(`GitHub Pages sites are limited to about 1 GB; this one is ${mb(total)}. Netlify, Vercel, Cloudflare Pages or S3 take it.`);
  const overCloudflare = files.filter(file => file.size > CLOUDFLARE_FILE_LIMIT);
  if (overCloudflare.length) warnings.push(`Cloudflare Pages refuses files over 25 MiB: ${named(overCloudflare)}. Use another host such as Netlify, or put those films on Cloudflare R2 (docs/hosting.md › Cloudflare Pages).`);
  return warnings;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ESCAPES[character]);

/**
 * The link-preview tags for an exported world: its title, its subtitle as the
 * description, `cover` (relative to the page, or absolute) and, when the world
 * has one, its preview loop `video` ({ ref, width, height }) as og:video. With
 * `url`, the page's public link, both become absolute and a qualifying video
 * becomes an X Player Card. Without a public URL or preview, keep the image card.
 */
export function previewTags(world, { cover, url = null, video = null }) {
  const title = escapeHtml(world.title), description = world.subtitle ? escapeHtml(world.subtitle) : null;
  const image = escapeHtml(url ? new URL(cover, url).href : cover);
  const meta = (key, name, content) => `<meta ${key}="${name}" content="${content}">`;
  return [`<title>${title}</title>`,
    description && meta('name', 'description', description),
    meta('property', 'og:title', title),
    description && meta('property', 'og:description', description),
    meta('property', 'og:image', image),
    url && meta('property', 'og:url', escapeHtml(url.href)),
    meta('name', 'twitter:card', url && video ? 'player' : 'summary_large_image'),
    meta('name', 'twitter:title', title),
    description && meta('name', 'twitter:description', description),
    meta('name', 'twitter:image', image),
    ...(url && video ? [
      meta('name', 'twitter:player', escapeHtml(new URL('preview/', url).href)),
      meta('name', 'twitter:player:width', String(video.width)),
      meta('name', 'twitter:player:height', String(video.height)),
      meta('name', 'twitter:player:stream', escapeHtml(new URL(video.ref, url).href)),
      meta('name', 'twitter:player:stream:content_type', 'video/mp4'),
    ] : []),
    ...(video ? [meta('property', 'og:video', escapeHtml(url ? new URL(video.ref, url).href : video.ref)),
      meta('property', 'og:video:type', 'video/mp4'),
      meta('property', 'og:video:width', String(video.width)),
      meta('property', 'og:video:height', String(video.height))] : [])].filter(Boolean);
}

/** A video-only iframe: no game bundle, sign-in, navigation or audible autoplay. */
function previewPlayer(world, { cover, url, video }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(world.title)} — Video Preview</title>
<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}video{display:block;width:100%;height:100%;object-fit:contain}</style>
</head>
<body>
<video controls autoplay muted loop playsinline preload="metadata" aria-label="${escapeHtml(world.title)} video preview" poster="${escapeHtml(new URL(cover, url).href)}">
<source src="${escapeHtml(new URL(video.ref, url).href)}" type="video/mp4">
</video>
</body>
</html>\n`;
}

/** The player's index.html with the world's preview tags in place of its placeholder title. */
export function withPreviewTags(html, world, options) {
  const tags = previewTags(world, options).join('\n    ');
  const title = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i;
  if (title.test(html)) return html.replace(title, () => tags);
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, closing => `  ${tags}\n  ${closing}`);
  throw new Error('The player\'s index.html has no <head>, so its link-preview tags cannot be written. Run: npm install, then export again.');
}

/** --url: the public HTTPS link visitors will play the world at, as the directory it is served from. */
export function publicPage(value) {
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || !isPublicHttps(url)) throw new Error('--url is the public HTTPS link visitors will play your world at, with no name or password in it.');
  return asDirectory(url);
}

export async function run(argv) {
  const { values, world } = parse(argv, { out: { type: 'string' }, url: { type: 'string' } });
  const page = values.url === undefined ? null : publicPage(values.url);
  const id = resolveWorldId(world);
  const paths = worldPaths(id);
  const worldFile = join(paths.build, 'world.json');
  if (!existsSync(worldFile)) {
    log.fail(`${shown(worldFile)} does not exist yet.`);
    log.next(gather(id).byState.approved.length ? `node world build ${id}` : nextStep(id));
    return 1;
  }
  const out = resolve(ROOT, values.out ?? join('dist', id));
  const { files, copied, remote, preview } = await exportWorld({ paths, out, url: page });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  log.ok(`${shown(out)}/ — ${files.length} files, ${mb(total)} (${copied} media files, every one in the web formats)`);
  if (remote.count) log.info(`${remote.count} media file${remote.count === 1 ? ' streams' : 's stream'} from other hosts and ${remote.count === 1 ? 'is' : 'are'} not checked here.`);
  if (remote.png.length) log.warn(`${remote.png.length} of them ${remote.png.length === 1 ? 'is a PNG still' : 'are PNG stills'} (${new URL(remote.png[0]).host}); served stills ship as WebP: ask that host for WebP copies.`);
  if (readJson(worldFile).draft) log.warn(`A draft: some films in it have no approved take yet (its About panel says so). Before sharing it, have them judged on node world review ${id}, then build and export again.`);
  for (const warning of hostWarnings(files, out)) log.warn(warning);
  if (preview.preview) log.info(`Its preview loop is ${preview.preview.ref} (named as og:video; node world submit lists it).`);
  else log.info(`No preview loop: ${preview.why}. You can make one (docs/hosting.md › Preview loop).`);
  if (page) log.info(preview.preview ? `Link previews use its video on X and its cover where video is unsupported, from ${page.href}.` : `Link previews show its cover from ${page.href}.`);
  else log.info(`Link previews: export again with --url <its public link> once you know it, so social sites and chat apps can show its cover.`);
  const rel = shown(out);
  log.info('Put it online (any one of these):');
  log.info(`  Cloudflare Pages  npx wrangler@4.129.0 login      (free; see docs/hosting.md)`);
  log.info(`                    npx wrangler@4.129.0 pages project create ${id} --production-branch main      (once)`);
  log.info(`                    npx wrangler@4.129.0 pages deploy ${rel} --project-name ${id} --branch main`);
  log.info(`  Netlify           npx netlify-cli@27.12.0 deploy --dir ${rel} --prod      (or drag the folder onto app.netlify.com/drop)`);
  log.info(`  Vercel            npx vercel@63.1.2 ${rel} --prod`);
  log.info(`  GitHub Pages      push the folder's contents to a gh-pages branch (see docs/hosting.md)`);
  log.info(`  Try it locally    npx serve@14.2.6 ${rel}`);
  return 0;
}

/** Build the player into `out`, copy the world beside it and give the page the world's preview tags. */
export async function exportWorld({ paths, out, url = null }) {
  const worldFile = join(paths.build, 'world.json');
  const data = readJson(worldFile);
  const issues = validateWorld(data);
  if (issues.length) throw new Error(`build/world.json is not valid: ${issues[0]}. Run: node world build ${paths.id}`);
  if (data.draft) log.warn(`Exporting a draft: visitors will see "Draft", and it cannot be submitted to the gallery. Before hosting, approve its takes on node world review ${paths.id} ("Approve this build’s takes" approves the version you played), then build without --drafts and export again. Unchanged films are not re-encoded.`);
  assertSafeOut(out);
  // Nothing outside the web formats goes online: checked before the folder is touched.
  const { issues: delivery, remote } = await deliveryIssues(data, paths.build);
  if (delivery.length) throw new Error([`Not exported: build/ would serve media outside the web formats (${delivery.length} problem${delivery.length === 1 ? '' : 's'}):`,
    ...delivery.map(issue => `  ${issue}`), DELIVERY_FIX.replace('node world build', `node world build ${paths.id}`)].join('\n'));

  // The player (vite empties the folder first).
  log.step('Building the player');
  const env = { ...process.env, PLAYER_OUT: out };
  delete env.WORLD;
  delete env.VITE_DEFAULT_WORLD;
  const code = await runVite(['build', '--logLevel', 'warn'], { env });
  if (code !== 0) throw new Error(`The player build failed (${code})`);

  // The world and everything it plays.
  log.step('Copying the world');
  copyFileSync(worldFile, join(out, 'world.json'));
  let copied = 0;
  for (const ref of mediaRefs(data)) {
    if (isRemote(ref)) continue;
    const source = resolve(paths.build, ref);
    if (!source.startsWith(paths.build + sep)) throw new Error(`world.json points outside build/: ${ref}`);
    if (!existsSync(source)) throw new Error(`world.json plays ${ref}, which is missing from build/. Run: node world build ${paths.id}`);
    const target = join(out, ref);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied++;
  }
  const social = existsSync(join(paths.build, SOCIAL.file));
  if (social) copyFileSync(join(paths.build, SOCIAL.file), join(out, SOCIAL.file));
  // The page's preview: its cover is the social card, or the opening still for a world built without one.
  const index = join(out, 'index.html');
  const cover = social ? SOCIAL.file : data.places.find(place => place.id === data.start).still;
  // Its preview loop, when the opening place's loop qualifies (lib/preview.js): nothing is made for it.
  const preview = await previewLoop(data, out);
  writeFileSync(index, withPreviewTags(readFileSync(index, 'utf8'), data, { cover, url, video: preview.preview }));
  if (url && preview.preview) {
    mkdirSync(join(out, 'preview'), { recursive: true });
    writeFileSync(join(out, 'preview/index.html'), previewPlayer(data, { cover, url, video: preview.preview }));
  }
  writeFileSync(join(out, '.nojekyll'), ''); // GitHub Pages: serve every file as it is
  const stray = strayPngs(data, out);
  if (stray.length) throw new Error([`${shown(out)} would serve ${stray.length} PNG${stray.length === 1 ? '' : 's'} that ${stray.length === 1 ? 'is' : 'are'} not icons:`, ...stray.map(issue => `  ${issue}`)].join('\n'));

  return { files: walk(out), copied, remote, preview };
}

/**
 * The output folder is emptied before the build, so it must be one that holds
 * nothing else: under dist/, or a folder that is empty or a previous export.
 */
function assertSafeOut(out) {
  if (ROOT === out || ROOT.startsWith(out + sep)) throw new Error(`--out ${out} would empty this repository; choose a folder of its own`);
  if (out.startsWith(ROOT + sep)) {
    if (!out.startsWith(join(ROOT, 'dist') + sep)) throw new Error('Inside this repository, export under dist/ (the default is dist/<world>)');
    return;
  }
  if (existsSync(out) && readdirSync(out).length && !(existsSync(join(out, 'world.json')) && existsSync(join(out, 'index.html')))) {
    throw new Error(`${out} already holds other files and would be emptied; choose an empty folder`);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push({ path, size: statSync(path).size });
  }
  return out;
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
