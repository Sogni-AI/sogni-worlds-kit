// export: a folder you can put on any static host.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { gather, nextStep } from './status.js';
import { ROOT, resolveWorldId, worldPaths, shown } from '../lib/paths.js';
import { readJson } from '../lib/files.js';
import { validateWorld, mediaRefs, isRemote } from '../lib/worldjson.js';
import { deliveryIssues, strayPngs, SOCIAL, DELIVERY_FIX } from '../lib/delivery.js';
import { runVite } from '../lib/player.js';

export const summary = 'Export a finished world as a static site for any host';
export const usage = `node world export [world] [--out dist/<world>]

  Checks that every film, still and sound build/world.json plays is in the web
  formats (WebP stills, films through Sogni's streaming profile, PNG only for
  icons) and stops if one is not. Then builds the player and copies the world,
  its media and its social card next to index.html. The folder works on GitHub
  Pages, Netlify, Vercel, Cloudflare Pages, S3 — anything that serves files.
  Guide: docs/hosting.md`;

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

export async function run(argv) {
  const { values, world } = parse(argv, { out: { type: 'string' } });
  const id = resolveWorldId(world);
  const paths = worldPaths(id);
  const worldFile = join(paths.build, 'world.json');
  if (!existsSync(worldFile)) {
    log.fail(`${shown(worldFile)} does not exist yet.`);
    log.next(gather(id).byState.approved.length ? `node world build ${id}` : nextStep(id));
    return 1;
  }
  const out = resolve(ROOT, values.out ?? join('dist', id));
  const { files, copied, remote } = await exportWorld({ paths, out });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  log.ok(`${shown(out)}/ — ${files.length} files, ${mb(total)} (${copied} media files, every one in the web formats)`);
  if (remote.count) log.info(`${remote.count} media file${remote.count === 1 ? ' streams' : 's stream'} from other hosts and ${remote.count === 1 ? 'is' : 'are'} not checked here.`);
  if (remote.png.length) log.warn(`${remote.png.length} of them ${remote.png.length === 1 ? 'is a PNG still' : 'are PNG stills'} (${new URL(remote.png[0]).host}); served stills ship as WebP: ask that host for WebP copies.`);
  if (readJson(worldFile).draft) log.warn(`A draft: some films in it have no approved take yet (its About panel says so). Before sharing it, have them judged on node world review ${id}, then build and export again.`);
  for (const warning of hostWarnings(files, out)) log.warn(warning);
  const rel = shown(out);
  log.info('Put it online (any one of these):');
  log.info(`  Cloudflare Pages  npx wrangler@4.129.0 login, then npx wrangler@4.129.0 pages deploy ${rel} --project-name ${id}      (free; see docs/hosting.md)`);
  log.info(`  Netlify           npx netlify-cli@27.12.0 deploy --dir ${rel} --prod      (or drag the folder onto app.netlify.com/drop)`);
  log.info(`  Vercel            npx vercel@63.1.2 ${rel} --prod`);
  log.info(`  GitHub Pages      push the folder's contents to a gh-pages branch (see docs/hosting.md)`);
  log.info(`  Try it locally    npx serve@14.2.6 ${rel}`);
  return 0;
}

/** Build the player into `out` and copy the world beside it. */
export async function exportWorld({ paths, out }) {
  const worldFile = join(paths.build, 'world.json');
  const data = readJson(worldFile);
  const issues = validateWorld(data);
  if (issues.length) throw new Error(`build/world.json is not valid: ${issues[0]}. Run: node world build ${paths.id}`);
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
  if (existsSync(join(paths.build, SOCIAL.file))) copyFileSync(join(paths.build, SOCIAL.file), join(out, SOCIAL.file));
  writeFileSync(join(out, '.nojekyll'), ''); // GitHub Pages: serve every file as it is
  const stray = strayPngs(data, out);
  if (stray.length) throw new Error([`${shown(out)} would serve ${stray.length} PNG${stray.length === 1 ? '' : 's'} that ${stray.length === 1 ? 'is' : 'are'} not icons:`, ...stray.map(issue => `  ${issue}`)].join('\n'));

  return { files: walk(out), copied, remote };
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
