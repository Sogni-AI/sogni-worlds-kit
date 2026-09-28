// review: your page for judging takes. Only a person approves.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan, filmsOf, placeById } from '../lib/plan.js';
import { resolveWorldId } from '../lib/paths.js';
import { listTakes, recordVerdict, readVerdicts, readNotes, VERDICTS } from '../lib/takes.js';
import { reviewPage } from '../lib/review-page.js';

export const summary = 'Open your review page: approve, reject or pass each new take';
export const usage = `node world review [world] [--port 4700]

  Serves a page on http://127.0.0.1:<port>/ with only the takes waiting for your
  verdict: each film's takes side by side, playing together, the one you tap
  is the one you hear. Approve the one you want; reject with a note saying what
  to change; "Seen" for a take that is fine but not the one. Verdicts are saved
  to review/verdicts.json, pinned to each file's SHA-256. Ctrl-C to stop.`;

const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const SERVABLE = ['renders', 'stills', 'keyframes'];

export async function run(argv) {
  const { values, world } = parse(argv, { port: { type: 'string', default: '4700' } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const first = awaitingFilms(plan, paths);
  if (!first.length) {
    log.ok('Nothing is waiting for your verdict.');
    log.next('node world next');
    return 0;
  }
  const port = Number(values.port);
  const server = await startReviewServer({ plan, paths, port, title: plan.title || id });
  const count = first.reduce((n, film) => n + film.takes.length, 0);
  log.ok(`${count} take(s) of ${first.length} film(s) await you.`);
  log.info(`Open http://127.0.0.1:${port}/`);
  log.dim('Verdicts save as you click. Ctrl-C when you are done.');
  await new Promise(done => process.on('SIGINT', () => { server.close(); done(); }));
  log.next('node world next');
  return 0;
}

/** Serve the review page for one world on 127.0.0.1. Resolves once listening. */
export async function startReviewServer({ plan, paths, port = 4700, title }) {
  const token = randomBytes(16).toString('hex');
  const server = createServer((request, response) => handle(request, response, { plan, paths, token, title })
    .catch(error => { response.writeHead(500, { 'content-type': 'text/plain' }); response.end(String(error.message)); }));
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  return server;
}

async function handle(request, response, context) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/') {
    const films = awaitingFilms(context.plan, context.paths);
    const html = reviewPage({ title: context.title, token: context.token, films });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/media/')) return serveFile(request, response, context.paths, decodeURIComponent(url.pathname.slice('/media/'.length)));
  if (request.method === 'POST' && url.pathname === '/verdict') {
    if (request.headers['x-review-token'] !== context.token) { response.writeHead(403); response.end('This page is out of date; reload it.'); return; }
    const body = JSON.parse(await readBody(request));
    const message = applyVerdict(context.plan, context.paths, body);
    response.writeHead(message ? 400 : 200, { 'content-type': 'text/plain' });
    response.end(message ?? 'ok');
    return;
  }
  response.writeHead(404); response.end('Not found');
}

/** Record a person's verdict; approving one take marks the film's other waiting takes as seen. */
export function applyVerdict(plan, paths, { sha, verdict, note }) {
  if (!VERDICTS.includes(verdict)) return `Unknown verdict "${verdict}"`;
  const film = filmsOf(plan).find(f => listTakes(paths, f.id).some(t => t.sha === sha));
  if (!film) return 'That take is not in this world';
  const takes = listTakes(paths, film.id);
  const take = takes.find(t => t.sha === sha);
  recordVerdict(paths, sha, { film: film.id, take: take.take, verdict, note: String(note ?? '').slice(0, 2000), by: 'you' });
  if (verdict === 'approved') {
    for (const other of takes) {
      if (other.sha !== sha && other.journal.status === 'completed' && other.sha && !other.verdict) {
        recordVerdict(paths, other.sha, { film: film.id, take: other.take, verdict: 'passed', note: `Take ${take.take} was approved`, by: 'you' });
      }
    }
  }
  return null;
}

/** Films with at least one finished take and no verdict on it, as the page needs them. */
export function awaitingFilms(plan, paths) {
  const verdicts = readVerdicts(paths);
  const notes = readNotes(paths);
  const media = path => `/media/${relative(paths.dir, path).split(sep).map(encodeURIComponent).join('/')}`;
  const still = placeId => { const place = placeById(plan, placeId); return place?.still && existsSync(join(paths.dir, place.still)) ? media(join(paths.dir, place.still)) : null; };
  const out = [];
  for (const film of filmsOf(plan)) {
    const takes = listTakes(paths, film.id, verdicts, notes);
    const waiting = takes.filter(t => t.journal.status === 'completed' && t.sha && !t.verdict && existsSync(t.files.video));
    if (!waiting.length) continue;
    const approved = takes.filter(t => t.verdict?.verdict === 'approved').at(-1);
    const from = placeById(plan, film.from), to = placeById(plan, film.to);
    const object = from?.objects?.find(o => o.id === film.object);
    const kindText = film.kind === 'crossing' ? `crossing from ${from?.title || film.from} to ${to?.title || film.to}`
      : film.kind === 'moment' ? `moment at ${from?.title || film.from}` : `living photograph of ${from?.title || film.from}`;
    out.push({
      id: film.id,
      kind: film.kind,
      kindText,
      label: object?.label ?? (film.kind === 'loop' ? `${from?.title || film.from}, alive` : film.id),
      idea: film.idea ?? '',
      prompt: waiting.at(-1).journal.prompt ?? '',
      fromStill: still(film.from),
      toStill: still(film.to),
      ref: approved && existsSync(approved.files.video) ? { take: approved.take, url: media(approved.files.video) } : null,
      takes: waiting.map(t => ({
        take: t.take,
        sha: t.sha,
        url: media(t.files.video),
        sheet: existsSync(t.files.sheet) ? media(t.files.sheet) : null,
        screened: Boolean(t.screen),
        flags: t.screen?.flags ?? [],
        notes: t.notes,
        meta: describe(t.journal),
      })),
    });
  }
  return out;
}

function describe(journal) {
  const parts = [];
  if (journal.width && journal.height) parts.push(`${journal.width * 2}×${journal.height * 2}`);
  if (journal.frames) parts.push(`${(journal.frames / 24).toFixed(2)} s`);
  if (journal.seed !== undefined && journal.seed !== null) parts.push(`seed ${journal.seed}`);
  if (journal.elapsedSeconds) parts.push(`made in ${(journal.elapsedSeconds / 60).toFixed(1)} min`);
  const spark = journal.quote?.spark ?? journal.estimatedTokenEquivalent;
  if (spark) parts.push(`${Math.round(Number(spark))} Spark${journal.billing?.mode === 'subscription' ? ' value, on your plan' : ''}`);
  return parts.join(' · ');
}

function serveFile(request, response, paths, relativePath) {
  const target = resolve(paths.dir, relativePath);
  const allowed = SERVABLE.some(dir => target.startsWith(resolve(paths.dir, dir) + sep));
  if (!allowed || !existsSync(target) || !statSync(target).isFile()) { response.writeHead(404); response.end(); return; }
  const size = statSync(target).size;
  const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) { response.writeHead(416, { 'content-range': `bytes */${size}` }); response.end(); return; }
    response.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    createReadStream(target, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(target).pipe(response);
}

function readBody(request) {
  return new Promise((done, fail) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) { fail(new Error('Too large')); request.destroy(); } });
    request.on('end', () => done(body));
    request.on('error', fail);
  });
}
