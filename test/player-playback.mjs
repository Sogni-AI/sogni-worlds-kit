#!/usr/bin/env node
// The player in a real browser, on a slow link. Each check is a fault found in a
// Sogni world's player (the Meme World ride, October 2026), reproduced in this
// player before it was fixed here, and kept from coming back:
//
//  1. join      A film landing on a place without a loop stays up until that
//               place's still can be drawn: never the place just left, never
//               black (5 Mbps).
//  2. pause     A film paused from outside the world (a media key, a headset
//               button, AirPods taken out) offers ▶ Play, which plays it on to
//               its landing; Skip lands it too.
//  3. give-up   A film given up before its first frame (Skip pressed at once)
//               stops downloading (1.5 Mbps).
//  4. panel     Arriving does not fetch the Places panel's pictures while it
//               is closed (found while checking 1 and 2: The Dream Thread
//               fetched all 23, 35 MB, at its second arrival).
//  5. skip-no-range / reveal-no-range: a partly downloaded crossing or close
//               look can be skipped when the host returns HTTP 200 to Range.
//  6. review-build: bulk approval confirms the exact built takes; Cancel saves nothing.
//  7. native    A world built by the kit mixing MiniMax H3 films at the world's
//               2K shape with Seedance films at their own 1080p (never
//               enlarged): every handover between them, on a desktop screen and
//               a phone held sideways, shows the same picture on both sides (no
//               jump, letterbox or layout shift; the blurred backdrop too), with
//               no console errors. The same world without `fill` must fail.
//
//   npm run check:player                 builds the player and runs every check
//   node test/player-playback.mjs --player <dir> [--only join,pause]
//
// Needs Google Chrome (H.264 films); CHROME_PATH points at another. It drives
// headless Chrome over the DevTools protocol with Node's own WebSocket, so the
// kit needs no browser package. Not part of `npm test`: it needs a browser.
import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { ffmpeg } from '../cli/lib/media.js';
import { runVite } from '../cli/lib/player.js';
import { validateWorld } from '../cli/lib/worldjson.js';
import { startReviewServer } from '../cli/commands/review.js';
import { readVerdicts, recordVerdict } from '../cli/lib/takes.js';
import { buildWorld } from '../cli/commands/build.js';
import { MODEL } from '../cli/lib/h3.js';
import { findCuts, joinsReport } from '../cli/lib/joins.js';
import { sha256File, writeJson } from '../cli/lib/files.js';
import { pathsAt } from './helpers.js';

const { values } = parseArgs({ options: { player: { type: 'string' }, only: { type: 'string' }, keep: { type: 'boolean' } } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = join(tmpdir(), `sogni-world-player-check-${process.pid}`);
mkdirSync(root, { recursive: true });

// ── The browser ─────────────────────────────────────────────────

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const onPath = name => (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, name)).find(existsSync);
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(dir => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(onPath).filter(Boolean);
  return candidates.find(path => existsSync(path)) ?? null;
}

/** A DevTools protocol connection: send() a command (to a page with its sessionId), on() for events. */
class Devtools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(`${waiting.method}: ${message.error.message}`));
        else waiting?.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
  }
  opened() {
    return new Promise((ok, fail) => { this.socket.addEventListener('open', ok, { once: true }); this.socket.addEventListener('error', fail, { once: true }); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

async function launch(chrome) {
  const profile = join(root, 'profile');
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { child.kill(); throw new Error(`${chrome} did not open a DevTools port`); }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const devtools = new Devtools(`ws://127.0.0.1:${port}${path}`);
  await devtools.opened();
  const exited = new Promise(done => child.once('exit', done));
  /** Chrome writes its profile as it quits: wait for it before the folder is removed. */
  const close = async () => {
    try { devtools.socket.close(); } catch { /* closed */ }
    child.kill();
    await Promise.race([exited, sleep(5000)]);
  };
  return { devtools, close };
}

/**
 * Watches every painted frame (installed before the player loads). A frame is
 * `wrong` when no visible film or loop has put a frame of its current source on
 * screen and the still under them has not loaded, so the screen shows the place
 * just left (an <img> keeps its old picture while a new one loads) or black.
 * Counted from the first film on, so the first place's own arrival is not judged.
 */
const WATCH = `(() => {
  const watch = window.__check = { wrong: 0, wrongRuns: [], reveals: 0, arrivals: 0 };
  const painted = new WeakMap(), hooked = new WeakSet();
  const hook = video => { if (hooked.has(video)) return; hooked.add(video);
    const frame = () => { painted.set(video, video.getAttribute('src') || ''); video.requestVideoFrameCallback(frame); };
    video.requestVideoFrameCallback(frame); };
  const ready = video => Boolean(video.getAttribute('src')) && painted.get(video) === video.getAttribute('src');
  let filmOn = false, armed = false;
  const tick = () => {
    const videos = [...document.querySelectorAll('.frame video')];
    videos.forEach(hook);
    const visible = videos.filter(v => v.classList.contains('on'));
    const films = visible.filter(v => v.classList.contains('film'));
    if (films.length && !filmOn) { watch.reveals += 1; armed = true; }
    filmOn = films.length > 0;
    const still = document.querySelector('.frame img.still');
    const stillUp = Boolean(still && still.complete && still.naturalWidth > 0);
    if (armed && !visible.some(ready) && !stillUp) {
      watch.wrong += 1;
      const last = watch.wrongRuns.at(-1), at = performance.now();
      if (last && at - last.end < 100) { last.end = at; last.frames += 1; } else watch.wrongRuns.push({ start: at, end: at, frames: 1, still: (still?.getAttribute('src') || '').split('/').pop() });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** A fresh page in its own browser context (its own cache), with the watch installed and the network counted. */
async function openPage(devtools, { throttle = null, viewport = { width: 1280, height: 800, scale: 1, mobile: false } } = {}) {
  const { browserContextId } = await devtools.send('Target.createBrowserContext');
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => devtools.send(method, params, sessionId);
  const requests = new Map();
  const loaded = new Set();
  // Every error the page reports: thrown, logged with console.error, or a failed load.
  const errors = [];
  devtools.on(message => {
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text);
    else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args.map(a => a.value ?? a.description).join(' '));
    else if (method === 'Log.entryAdded' && params.entry.level === 'error') errors.push(`${params.entry.text} ${params.entry.url ?? ''}`.trim());
    if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { url: params.request.url, type: params.type, received: [] });
    else if (method === 'Network.dataReceived') requests.get(params.requestId)?.received.push([Date.now(), params.encodedDataLength || params.dataLength]);
    else if (method === 'Network.loadingFinished') { const r = requests.get(params.requestId); if (r) r.finished = true; }
    else if (method === 'Page.loadEventFired') loaded.add(true);
  });
  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.mobile,
    ...(viewport.mobile ? { screenOrientation: { type: viewport.width > viewport.height ? 'landscapePrimary' : 'portraitPrimary', angle: viewport.width > viewport.height ? 90 : 0 } } : {}) });
  if (viewport.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
  if (throttle) await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: throttle * 125_000, uploadThroughput: throttle * 125_000 });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const page = {
    send, sessionId, errors,
    evaluate,
    async open(url) {
      loaded.clear();
      await send('Page.navigate', { url });
      for (let i = 0; i < 300 && !loaded.size; i++) await sleep(100);
    },
    /** Bytes of URLs containing `part`, received between two times (ms since the epoch). */
    bytes(part, from = 0, to = Infinity) {
      let sum = 0;
      for (const r of requests.values()) if (r.url.includes(part)) for (const [at, n] of r.received) if (at >= from && at <= to) sum += n;
      return sum;
    },
    fetched: part => [...requests.values()].some(r => r.url.includes(part) && r.type === 'Fetch' && r.finished),
    state: () => evaluate(`(() => {
      const app = document.getElementById('app'), film = document.querySelector('.frame video.film.on');
      const buttons = [...document.querySelectorAll('button')].filter(b => !b.hidden && b.offsetParent !== null).map(b => b.textContent.trim());
      return { begun: !document.querySelector('section.begin'), inFilm: Boolean(app?.classList.contains('in-film')),
        hotspots: Boolean(document.querySelector('.hotspots:not([hidden]) .hotspot')), place: document.querySelector('.where .place')?.textContent ?? null,
        film: film ? { t: film.currentTime, duration: film.duration, paused: film.paused, ended: film.ended,
          bufferedEnd: film.buffered.length ? film.buffered.end(film.buffered.length - 1) : 0 } : null,
        holding: Boolean(app?.classList.contains('holding')), still: document.querySelector('.frame img.still')?.getAttribute('src'),
        text: app?.textContent, buttons, check: window.__check };
    })()`),
    click: text => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)} && !x.hidden); if (!b) return false; b.click(); return true; })()`),
    spot: label => evaluate(`(() => { const b = [...document.querySelectorAll('.hotspot .label')].find(x => x.querySelector('.action')?.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`),
    /** Pause the playing film the way a media key does: not through the player's code. */
    pauseFromOutside: () => evaluate(`(() => { const v = document.querySelector('.frame video.film.on'); if (!v) return false; HTMLMediaElement.prototype.pause.call(v); return true; })()`),
    close: () => devtools.send('Target.disposeBrowserContext', { browserContextId }).catch(() => undefined),
  };
  return page;
}

async function until(page, test, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const state = await page.state();
    if (test(state)) return state;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label} (${JSON.stringify({ ...state, check: undefined })})`);
    await sleep(100);
  }
}
const atRest = s => s.begun && !s.inFilm && s.hotspots;

// ── A world small enough to make on the spot ────────────────────

/**
 * Three places: the yard (a loop), the hall (no loop, as in The Dream Thread,
 * so a film lands on its still) and the roof (a loop). Stills are noise, which
 * does not compress, so the hall's takes ~2.5 s to arrive at 5 Mbps.
 */
async function makeWorld(dir) {
  const W = 960, H = 540;
  mkdirSync(join(dir, 'films'), { recursive: true });
  mkdirSync(join(dir, 'stills'), { recursive: true });
  const stills = { yard: 70, hall: 130, roof: 190 };
  for (const [id, mean] of Object.entries(stills)) {
    await sharp({ create: { width: W, height: H, channels: 3, noise: { type: 'gaussian', mean, sigma: 50 } } }).png({ compressionLevel: 1 }).toFile(join(dir, 'stills', `${id}.png`));
  }
  const film = (name, seconds, { heavy = false, tone = 440 } = {}) => ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=24${heavy ? ',noise=alls=80:allf=t' : ''}`, '-f', 'lavfi', '-i', `sine=f=${tone}:sample_rate=48000`,
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...(heavy ? ['-b:v', '8M'] : ['-crf', '30']),
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', join(dir, 'films', `${name}.mp4`)]);
  await Promise.all([film('yard-loop', 3), film('roof-loop', 3, { tone: 520 }), film('yard-hall', 3, { tone: 600 }),
    film('hall-roof', 4, { tone: 660 }), film('roof-yard', 3, { tone: 700 }), film('yard-roof', 8, { heavy: true, tone: 760 })]);
  const spot = (id, label, to, src, at) => ({ id, label, at, to, film: { src: `films/${src}.mp4` } });
  const world = {
    format: 'sogni-world@1', id: 'player-check', title: 'Player check', aspect: { width: W, height: H }, start: 'yard', order: null, music: null,
    places: [
      { id: 'yard', title: 'Yard', still: 'stills/yard.png', loop: { src: 'films/yard-loop.mp4' },
        hotspots: [spot('door', 'Into the hall', 'hall', 'yard-hall', [0.3, 0.5]), spot('ladder', 'Up the ladder', 'roof', 'yard-roof', [0.7, 0.5]),
          { ...spot('clue', 'Look at the clue', null, 'yard-roof', [0.5, 0.5]), reveal: { still: 'stills/hall.png',
            back: { src: 'films/yard-hall.mp4' }, narration: { lines: [{ text: 'The clue is here.' }] }, done: 'Put it down' } }] },
      { id: 'hall', title: 'Hall', still: 'stills/hall.png', hotspots: [spot('stairs', 'Up the stairs', 'roof', 'hall-roof', [0.5, 0.5])] },
      { id: 'roof', title: 'Roof', still: 'stills/roof.png', loop: { src: 'films/roof-loop.mp4' }, hotspots: [spot('down', 'Back down', 'yard', 'roof-yard', [0.5, 0.5])] },
    ],
  };
  const issues = validateWorld(world);
  if (issues.length) throw new Error(`the check's world is not valid: ${issues.join('; ')}`);
  writeFileSync(join(dir, 'world.json'), JSON.stringify(world, null, 2));
}

/**
 * A world the kit's own build makes, on a 16:9 canvas (2688×1536 stills):
 *   A: an H3 loop, and a Seedance crossing east to B
 *   B: a Seedance loop, and an H3 crossing south to C
 *   C: an H3 loop, and a Seedance crossing west to A (Back plays its Seedance rewind)
 * Its stills are sharp grids, so a picture drawn at another place or scale is a
 * large difference. A Seedance take is its stills squeezed to 1920×1080, as
 * they are sent to Seedance; every film holds its first and last picture for
 * 1.5 s, so a handover compares the same picture on both sides.
 */
async function makeNativeWorld(dir) {
  const paths = pathsAt(dir, 'native-check');
  mkdirSync(paths.stills, { recursive: true });
  const W = 2688, H = 1536;
  const colours = { a: ['#1d4e89', '#f2c14e'], b: ['#7a1f3d', '#9ee493'], c: ['#2b2d42', '#ef8354'] };
  for (const [id, [ground, ink]] of Object.entries(colours)) {
    const lines = [];
    for (let x = 0; x <= W; x += 96) lines.push(`<rect x="${x - 3}" y="0" width="6" height="${H}" fill="${ink}"/>`);
    for (let y = 0; y <= H; y += 96) lines.push(`<rect x="0" y="${y - 3}" width="${W}" height="6" fill="${ink}"/>`);
    const marks = [[0.08, 0.1], [0.92, 0.1], [0.08, 0.9], [0.92, 0.9], [0.5, 0.5], [0.3, 0.62], [0.71, 0.37]]
      .map(([x, y], i) => `<circle cx="${x * W}" cy="${y * H}" r="${60 + i * 9}" fill="none" stroke="#fff" stroke-width="10"/>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${ground}"/>${lines.join('')}${marks.join('')}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(join(paths.stills, `${id}.png`));
  }
  const H3 = { width: W, height: H }, SEEDANCE = { width: 1920, height: 1080 };
  const take = async (film, size, model, tone, inputs, graph) => {
    const video = join(paths.renders, film, 'take-1.mp4');
    mkdirSync(join(paths.renders, film), { recursive: true });
    await ffmpeg([...inputs.flatMap(still => ['-loop', '1', '-framerate', '24', '-t', '2.5', '-i', join(paths.stills, `${still}.png`)]),
      '-f', 'lavfi', '-i', `sine=f=${tone}:sample_rate=48000`, '-filter_complex', graph(`scale=${size.width}:${size.height}:flags=lanczos,setsar=1,format=yuv420p`),
      '-map', '[v]', '-map', `${inputs.length}:a`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-r', '24', '-c:a', 'aac', '-shortest', video]);
    const sha = sha256File(video);
    writeJson(join(paths.renders, film, 'take-1.json'), { film, take: 1, status: 'completed', sha256: sha, model, ...(model === MODEL ? {} : { finalizes: 1 }) });
    recordVerdict(paths, sha, { film, take: 1, verdict: 'approved', by: 'you' });
  };
  const loop = (film, size, model, still, tone) => take(film, size, model, tone, [still, still], fit => `[0:v]${fit}[p];[1:v]${fit}[q];[p][q]concat=n=2:v=1:a=0[v]`);
  // 1.5 s of the first picture, a 1 s fade, 1.5 s of the last (an xfade of two 2.5 s stills).
  const crossing = (film, size, model, from, to, tone) => take(film, size, model, tone, [from, to], fit => `[0:v]${fit}[p];[1:v]${fit}[q];[p][q]xfade=transition=fade:duration=1:offset=1.5[v]`);
  await Promise.all([
    loop('a-loop', H3, MODEL, 'a', 300), loop('b-loop', SEEDANCE, 'seedance-2-5', 'b', 340), loop('c-loop', H3, MODEL, 'c', 380),
    crossing('a-east', SEEDANCE, 'seedance-2-5', 'a', 'b', 420), crossing('b-south', H3, MODEL, 'b', 'c', 460), crossing('c-west', SEEDANCE, 'seedance-2-5', 'c', 'a', 500),
  ]);
  const place = (id, title, loopModel, object) => ({ id, title, still: `stills/${id}.png`, loop: { ...(loopModel ? { model: loopModel } : {}), frames: 120, action: 'x', sound: 'y' }, objects: [object] });
  const plan = { id: 'native-check', title: 'Native check', canvas: '1344x768', order: 'free', voices: {}, music: null, places: [
    place('a', 'Place A', null, { id: 'east', label: 'East to B', at: [0.5, 0.45], goes: 'b', film: { model: 'seedance-2-5', frames: 97 } }),
    place('b', 'Place B', 'seedance-2-5', { id: 'south', label: 'South to C', at: [0.5, 0.45], goes: 'c', film: { frames: 97 } }),
    place('c', 'Place C', null, { id: 'west', label: 'West to A', at: [0.5, 0.45], goes: 'a', film: { model: 'seedance-2-5', frames: 97 } }),
  ] };
  const quiet = { step() {}, ok() {}, warn() {}, info() {}, fail() {}, title() {}, next() {}, dim() {} };
  const { world, issues, delivery } = await buildWorld({ paths, plan, say: quiet });
  if (issues.length || delivery.length) throw new Error(`the native world did not build: ${[...issues, ...delivery].join('; ')}`);
  // The same world as a player without `fill` would show it: the control the check must catch.
  const strip = value => (Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fill').map(([key, v]) => [key, strip(v)])) : value);
  writeFileSync(join(paths.build, 'world-nofill.json'), JSON.stringify(strip(world), null, 2));
  return world;
}

/** The picture's layout: the frame, the layer on top in it, and the blurred backdrop behind. */
const GEOMETRY = `(() => {
  const box = e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 100) / 100); };
  const frame = document.querySelector('.frame');
  const top = [...frame.querySelectorAll('video.on')].filter(v => getComputedStyle(v).visibility === 'visible').at(-1);
  const back = document.querySelector('.backdrop video.on');
  return { frame: box(frame), dpr: devicePixelRatio,
    layer: top ? { box: box(top), fit: getComputedStyle(top).objectFit, size: [top.videoWidth, top.videoHeight], src: (top.getAttribute('src') || '').split('/').pop() } : null,
    backdrop: back ? { box: box(back), fit: getComputedStyle(back).objectFit } : null };
})()`;

/** The picture alone: the player's controls and labels hidden, and every handover timed. */
const PICTURE_ONLY = `(() => {
  const style = document.createElement('style');
  style.textContent = '#app > :not(.backdrop):not(.frame), .frame > .overlay { visibility: hidden !important; }';
  document.head.append(style);
  window.__handovers = [];
  new MutationObserver(records => { for (const r of records) if (r.target.matches('.frame video.film')) window.__handovers.push({ t: Date.now(), on: r.target.classList.contains('on') }); })
    .observe(document.querySelector('.frame'), { subtree: true, attributes: true, attributeFilter: ['class'] });
})()`;

/** Mean absolute difference (0–255) of two screenshots inside `rect` (device pixels), or outside it. */
async function difference(a, b, rect, { outside = false } = {}) {
  const [pa, pb] = await Promise.all([a, b].map(png => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  const { width, height } = pa.info;
  let sum = 0, n = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
    if (inside === outside) continue;
    const i = (y * width + x) * 3;
    sum += Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
    n += 3;
  }
  return n ? sum / n : 0;
}

/**
 * Above this, the two sides of a handover are not the same picture. Measured: the right picture
 * differs by 1.5 to 5.6 (codec noise, and two sources of different sizes resampled to one screen),
 * a Seedance film misfit by its 1.6% squeeze by 13.6 to 17.7.
 */
const SAME_PICTURE = 8;

/** Both sides of each handover: the picture and the backdrop compared, and the layout on each side. */
async function compare(pairs) {
  const results = [];
  for (const [a, b] of pairs) {
    const { frame, dpr } = a.geometry;
    const rect = { x: Math.round(frame[0] * dpr) + 2, y: Math.round(frame[1] * dpr) + 2, w: Math.round(frame[2] * dpr) - 4, h: Math.round(frame[3] * dpr) - 4 };
    const shifted = JSON.stringify(a.geometry.frame) !== JSON.stringify(b.geometry.frame);
    // No letterbox and no shift: the picture on top fills exactly the frame on both sides.
    const unfilled = [a, b].filter(side => JSON.stringify(side.geometry.layer?.box) !== JSON.stringify(side.geometry.frame));
    results.push({ from: a.label, to: b.label, frame: await difference(a.png, b.png, rect), backdrop: await difference(a.png, b.png, rect, { outside: true }),
      shifted, unfilled: unfilled.map(side => side.label), fits: [a, b].map(side => `${side.geometry.layer?.size.join('×')} ${side.geometry.layer?.fit}`) });
  }
  return results;
}

/**
 * Walk the native world once at one screen size: every crossing and Back.
 * Either screenshot the picture on both sides of each handover, or
 * screencast the whole walk for `node world joins`: never both at once, since
 * a full-size screenshot on a 3× screen puts cropped frames into the screencast.
 */
async function nativeWalk(devtools, url, view, out, { record = false } = {}) {
  mkdirSync(out, { recursive: true });
  const page = await openPage(devtools, { viewport: view });
  const cast = [];
  const stop = devtools.on(message => {
    if (message.sessionId !== page.sessionId || message.method !== 'Page.screencastFrame') return;
    cast.push({ t: message.params.metadata.timestamp, data: message.params.data, metadata: message.params.metadata });
    void page.send('Page.screencastFrameAck', { sessionId: message.params.sessionId });
  });
  try {
    await begin(page, url);
    await page.evaluate(PICTURE_ONLY);
    if (record) await page.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: view.width, maxHeight: view.height, everyNthFrame: 1 });
    const shot = async label => {
      if (record) return null;
      const geometry = await page.evaluate(GEOMETRY);
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(data, 'base64');
      writeFileSync(join(out, `${String(shots++).padStart(2, '0')} ${label}.png`), png);
      return { label, geometry, png };
    };
    let shots = 0;
    const filmStart = s => s.film && s.film.t > 0.15 && s.film.t < 1.0;
    const filmEnd = s => s.film && Number.isFinite(s.film.duration) && s.film.t > s.film.duration - 1.2 && s.film.t < s.film.duration - 0.3;
    const pairs = [];
    await sleep(600);
    let before = await shot('A at rest (H3 loop)');
    const legs = [['East to B', 'Place B', 'B at rest (Seedance loop)'], ['South to C', 'Place C', 'C at rest (H3 loop)'], ['West to A', 'Place A', 'A at rest (H3 loop)'], ['← Back', 'Place C', 'C at rest (H3 loop)']];
    for (const [go, place, rest] of legs) {
      if (go === '← Back') await page.click(go); else await page.spot(go);
      try { await until(page, filmStart, 30_000, `${go} to start`); }
      catch (error) { throw new Error(`${error.message}; videos: ${JSON.stringify(await page.evaluate(`[...document.querySelectorAll('video')].map(v => ({ c: v.className, src: (v.getAttribute('src') || '').split('/').pop(), rs: v.readyState, ns: v.networkState, err: v.error?.message ?? v.error?.code ?? null, t: v.currentTime, p: v.paused }))`))}`); }
      const first = await shot(`${go} first picture`);
      if (!record) pairs.push([before, first]);
      await until(page, filmEnd, 30_000, `${go} to reach its last picture`);
      const last = await shot(`${go} last picture`);
      await until(page, s => atRest(s) && s.place === place, 30_000, `${place}`);
      await sleep(500);
      before = await shot(rest);
      if (!record) pairs.push([last, before]);
    }
    if (!record) return { results: await compare(pairs), errors: [...page.errors] };
    await page.send('Page.stopScreencast');
    const handovers = await page.evaluate('window.__handovers');
    // The walk as a film, for `node world joins` at every handover.
    const recording = join(out, 'walk.mp4');
    const list = cast.map((frame, i) => {
      const file = join(out, 'cast', `${String(i).padStart(5, '0')}.jpg`);
      mkdirSync(join(out, 'cast'), { recursive: true });
      writeFileSync(file, Buffer.from(frame.data, 'base64'));
      return `file '${file}'\nduration ${Math.max(0.001, (cast[i + 1]?.t ?? frame.t + 0.04) - frame.t).toFixed(4)}`;
    });
    writeFileSync(join(out, 'cast.txt'), list.join('\n'));
    writeFileSync(join(out, 'cast.json'), JSON.stringify(cast.map(frame => ({ ...frame.metadata, bytes: frame.data.length })), null, 1));
    // Chrome sends some frames in device pixels (2532×1170 for a 3× phone) and the rest in CSS pixels: one size for all.
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(out, 'cast.txt'), '-vf', `scale=${view.width}:${view.height}:flags=lanczos,setsar=1,fps=24`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', recording]);
    rmSync(join(out, 'cast'), { recursive: true, force: true });
    const at = handovers.map(h => h.t / 1000 - cast[0].t).filter(t => t > 0);
    const joins = await joinsReport(recording, { out: join(out, 'joins'), at });
    const cuts = await findCuts(recording);
    return { errors: [...page.errors], handovers: at.length, joins, cuts: cuts.map(f => +(f / 24).toFixed(2)), recording };
  } finally {
    stop();
    await page.close();
  }
}

/** The player at /, the world at /world/, with byte ranges (video seeks need them). */
function serve(playerDir, worldDir) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = createServer((req, res) => {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const noRanges = path.startsWith('/no-range/');
    if (noRanges) path = path.slice('/no-range'.length);
    const [base, rel] = path.startsWith('/world/') ? [worldDir, path.slice(7)] : [playerDir, path.slice(1) || 'index.html'];
    const file = resolve(base, rel);
    if (!file.startsWith(resolve(base) + sep) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    const size = statSync(file).size;
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    if (!noRanges) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    const range = noRanges ? null : /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    let start = 0, end = size - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!(start <= end)) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', String(end - start + 1));
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

// ── The checks ──────────────────────────────────────────────────

async function begin(page, url) {
  await page.open(url);
  await until(page, s => s.buttons.includes('Begin'), 30_000, 'the Begin card');
  await page.click('Begin');
  return until(page, atRest, 60_000, 'the first place');
}

const CHECKS = {
  /** SAM video paths follow the visible loop's clock, then stop during a crossing. */
  async tracking(devtools, url) {
    const file = join(root, 'world', 'world.json');
    const world = JSON.parse(readFileSync(file, 'utf8'));
    const shapes = ['M120 180L240 180L240 300Z', 'M360 180L480 180L480 300Z', 'M600 180L720 180L720 300Z'];
    world.places[0].hotspots[0].outlineTrack = { width: 960, height: 540, fps: 24,
      frames: Array.from({ length: 72 }, (_, i) => shapes[Math.floor(i / 24)]) };
    writeJson(join(root, 'world', 'tracking.json'), world);
    const at = new URL(url);
    at.searchParams.set('world', new URL('/world/tracking.json', at.origin).href);
    const page = await openPage(devtools);
    try {
      await begin(page, at.href);
      const samples = [];
      for (const time of [0.1, 1.1, 2.1, 0.1]) {
        const sample = await page.evaluate(`(async () => {
          const video = document.querySelector('.frame video.loop.on');
          if (!video) throw new Error('no visible loop');
          video.pause();
          await new Promise(done => { video.addEventListener('seeked', done, { once: true }); video.currentTime = ${time}; });
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          return [...document.querySelectorAll('.hotspot:first-child svg path')].map(p => p.getAttribute('d'));
        })()`);
        samples.push(sample);
        if (!sample.length || sample.some(d => d !== shapes[Math.floor(time)])) {
          return { ok: false, detail: 'path did not follow loop time ' + time + ': ' + JSON.stringify(sample) };
        }
      }
      await page.evaluate(`document.querySelector('.hotspot:first-child svg path').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      await until(page, s => s.inFilm, 10_000, 'the tracked crossing');
      const hidden = await page.evaluate(`document.querySelector('.hotspots').hidden`);
      await page.click('Skip');
      await until(page, s => atRest(s) && s.place === 'Hall', 30_000, 'the hall');
      const staticSpot = await page.evaluate(`document.querySelectorAll('.hotspots:not([hidden]) .hotspot').length`);
      const ok = hidden && staticSpot === 1 && !page.errors.length;
      return { ok, detail: 'four frame-clock seeks including wrap; all SVG hit paths aligned; click reached Hall; static hotspot retained; ' + page.errors.length + ' errors' };
    } finally { await page.close(); }
  },

  /** Native-size Seedance films beside H3 films: the same picture across every handover, on desktop and a phone held sideways. */
  async native(devtools, url) {
    const dir = join(root, 'world', 'native');
    if (!existsSync(join(dir, 'build', 'world.json'))) await makeNativeWorld(dir);
    const worldAt = file => { const page = new URL(url); page.searchParams.set('world', new URL(`/world/native/build/${file}`, page.origin).href); return page.href; };
    const views = [{ name: 'desktop', width: 1280, height: 800, scale: 1, mobile: false }, { name: 'phone-sideways', width: 844, height: 390, scale: 3, mobile: true }];
    const lines = [];
    let ok = true;
    for (const view of views) {
      const shots = await nativeWalk(devtools, worldAt('world.json'), view, join(root, 'native-evidence', view.name));
      const recorded = await nativeWalk(devtools, worldAt('world.json'), view, join(root, 'native-evidence', `${view.name}-recording`), { record: true });
      const walk = { ...shots, ...recorded, errors: [...shots.errors, ...recorded.errors] };
      const worst = Math.max(...walk.results.map(r => r.frame));
      const bad = walk.results.filter(r => r.frame > SAME_PICTURE || r.backdrop > SAME_PICTURE || r.shifted || r.unfilled.length);
      // A film not at the world's shape (2688×1536, or its half copy) is a native Seedance film: it must be stretched.
      const native = walk.results.flatMap(r => r.fits).filter(fit => { const [w, h] = fit.split(' ')[0].split('×').map(Number); return w * 1536 !== h * 2688; });
      const nativeFill = native.length > 0 && native.every(fit => fit.endsWith('fill'));
      const passed = !bad.length && !walk.errors.length && !walk.cuts.length && nativeFill;
      ok &&= passed;
      lines.push(`${view.name} ${view.width}×${view.height}@${view.scale}x: ${walk.results.length} handovers, picture differs by at most ${worst.toFixed(2)}/255 `
        + `(backdrop ${Math.max(...walk.results.map(r => r.backdrop)).toFixed(2)}), ${walk.results.filter(r => r.shifted).length} layout shifts, `
        + `${walk.results.filter(r => r.unfilled.length).length} letterboxed, ${walk.cuts.length} hard cuts in the recording, ${walk.errors.length} console errors`
        + (bad.length ? `; not the same picture: ${bad.map(r => `${r.from} → ${r.to} (${r.frame.toFixed(1)}, backdrop ${r.backdrop.toFixed(1)}${r.shifted ? ', shifted' : ''}${r.unfilled.length ? ', letterboxed' : ''})`).join('; ')}` : '')
        + (walk.errors.length ? `; errors: ${walk.errors.slice(0, 3).join(' | ')}` : '') + (walk.cuts.length ? `; cuts at ${walk.cuts.join(', ')} s` : '') + (nativeFill ? '' : '; a 1920×1080 film was not stretched to the frame'));
      for (const r of walk.results) lines.push(`    ${r.from} → ${r.to}: ${r.frame.toFixed(2)} (backdrop ${r.backdrop.toFixed(2)}) [${r.fits.join(' → ')}]`);
    }
    // The control: the same native files without `fill` (drawn like every other film) must show the jump.
    const control = { ...await nativeWalk(devtools, worldAt('world-nofill.json'), views[0], join(root, 'native-evidence', 'control-without-fill')),
      ...await nativeWalk(devtools, worldAt('world-nofill.json'), views[0], join(root, 'native-evidence', 'control-without-fill-recording'), { record: true }) };
    const caught = control.results.filter(r => r.frame > SAME_PICTURE).length;
    if (!caught) ok = false;
    lines.push(`control without fill: ${caught} of ${control.results.length} handovers jump (worst ${Math.max(...control.results.map(r => r.frame)).toFixed(2)}/255), ${control.cuts.length} hard cuts in its recording${caught ? '' : ' — the check cannot see a jump'}`);
    return { ok, detail: lines.join('\n  ') };
  },

  /** The creator may cancel bulk approval; confirming approves only the build's selected take. */
  async 'review-build'(devtools) {
    const paths = pathsAt(join(root, 'review-world'));
    const plan = { title: 'Review browser check', places: [{ id: 'a', loop: {}, objects: [] }] };
    mkdirSync(join(paths.renders, 'a-loop'), { recursive: true });
    const shas = [];
    for (const [index, name] of ['yard-loop', 'yard-hall'].entries()) {
      const n = index + 1;
      const file = join(paths.renders, 'a-loop', `take-${n}.mp4`);
      copyFileSync(join(root, 'world', 'films', `${name}.mp4`), file);
      const sha = sha256File(file);
      shas.push(sha);
      writeJson(join(paths.renders, 'a-loop', `take-${n}.json`), { status: 'completed', sha256: sha });
    }
    writeJson(join(paths.build, 'world.json'), { draft: true, places: [{ id: 'a', loop: { src: 'films/a-loop.mp4' }, hotspots: [] }] });
    writeJson(join(paths.build, '.manifest.json'), { 'films/a-loop.mp4': { source: shas[0] } });
    const server = await startReviewServer({ plan, paths, title: plan.title, port: 0 });
    const page = await openPage(devtools);
    let accept = false, prompts = 0;
    const stop = devtools.on(message => {
      if (message.method !== 'Page.javascriptDialogOpening') return;
      prompts++;
      void devtools.send('Page.handleJavaScriptDialog', { accept }, message.sessionId);
    });
    try {
      await page.open(`http://127.0.0.1:${server.address().port}/`);
      await page.click('Approve this build’s takes');
      if (prompts !== 1 || Object.keys(readVerdicts(paths)).length) return { ok: false, detail: 'cancel changed verdicts or did not ask for confirmation' };
      accept = true;
      await page.click('Approve this build’s takes');
      for (let i = 0; i < 50 && !readVerdicts(paths)[shas[0]]; i++) await sleep(100);
      const verdicts = readVerdicts(paths);
      const remaining = await page.evaluate(`document.querySelector('#count').textContent`);
      const ok = prompts === 2 && verdicts[shas[0]]?.verdict === 'approved' && !verdicts[shas[1]] && remaining === '1 take awaits you';
      return { ok, detail: ok ? 'Cancel saved nothing; Confirm approved the built take and left the newer take waiting' : JSON.stringify({ prompts, verdicts, remaining }) };
    } finally {
      stop();
      await page.close();
      await new Promise(done => server.close(done));
    }
  },

  /** A host that ignores Range cannot strand a visitor in a partly downloaded film. */
  async 'skip-no-range'(devtools, url) {
    const page = await openPage(devtools, { throttle: 12 });
    try {
      const hosted = new URL(url);
      const world = new URL(hosted.searchParams.get('world'));
      world.pathname = '/no-range' + world.pathname;
      hosted.searchParams.set('world', world.href);
      await begin(page, hosted.href);
      await page.spot('Up the ladder');
      const playing = await until(page, s => s.film && s.film.t > 0.6, 30_000, 'the unbuffered crossing');
      if (playing.film.bufferedEnd >= playing.film.duration - 0.05) return { ok: false, detail: 'the crossing fully downloaded; the no-range path was not exercised' };
      await page.click('Skip ›');
      await until(page, s => atRest(s) && s.place === 'Roof', 3000, 'Skip to land without downloading the end');
      await page.click('← Back');
      await until(page, s => s.inFilm, 3000, 'Back from the landing');
      await sleep(700);
      await page.click('Skip ›');
      await until(page, s => atRest(s) && s.place === 'Yard', 10_000, 'Back to the yard');
      return { ok: true, detail: '960×540, 8 s crossing at 1.5 MB/s, HTTP 200: Skip landed within 3 s and Back returned to the yard' };
    } finally { await page.close(); }
  },

  /** Skipping an unbuffered close look shows its still, its clue and its Done button. */
  async 'reveal-no-range'(devtools, url) {
    const page = await openPage(devtools, { throttle: 12 });
    try {
      const hosted = new URL(url);
      const world = new URL(hosted.searchParams.get('world'));
      world.pathname = '/no-range' + world.pathname;
      hosted.searchParams.set('world', world.href);
      await begin(page, hosted.href);
      await page.spot('Look at the clue');
      const playing = await until(page, s => s.film && s.film.t > 0.6, 30_000, 'the unbuffered close look');
      if (playing.film.bufferedEnd >= playing.film.duration - 0.05) return { ok: false, detail: 'the close look fully downloaded; the no-range path was not exercised' };
      await page.click('Skip ›');
      const held = await until(page, s => s.holding && s.buttons.includes('Put it down') && s.text.includes('The clue is here.'), 3000, 'the close look and its line to hold');
      const ok = !held.film && held.still.endsWith('/stills/hall.png') && held.text.includes('The clue is here.');
      if (!ok) return { ok: false, detail: 'the close look held a mid-film frame or lost its still, line or Done button: ' + JSON.stringify(held) };
      await page.click('Put it down');
      await until(page, atRest, 20_000, 'the close look to return');
      return { ok: true, detail: '960×540, 8 s close look at 1.5 MB/s, HTTP 200: Skip showed its still, clue and Done; Done returned to the yard' };
    } finally { await page.close(); }
  },

  /** A film landing on a place with no loop hands over only to a still that can be drawn. */
  async join(devtools, url) {
    const page = await openPage(devtools, { throttle: 5 });
    try {
      await begin(page, url);
      // The film itself plays from memory, so the join is about the still alone.
      for (let i = 0; i < 300 && !page.fetched('yard-hall.mp4'); i++) await sleep(100);
      await page.spot('Into the hall');
      await until(page, s => s.inFilm, 20_000, 'the film');
      await until(page, s => atRest(s) && s.place === 'Hall', 60_000, 'the hall');
      await sleep(4000); // the hall's still has arrived by now
      const { check } = await page.state();
      const ok = check.wrong === 0;
      return { ok, detail: ok ? 'the film stayed up until the hall\'s still could be drawn' : `${check.wrong} frames showed the place just left or black after the film (runs: ${check.wrongRuns.map(r => `${r.frames} frames over ${Math.round(r.end - r.start)} ms, still ${r.still}`).join('; ')})` };
    } finally { await page.close(); }
  },

  /** A film paused from outside offers ▶ Play, which lands it; Skip lands one too. */
  async pause(devtools, url) {
    const page = await openPage(devtools);
    try {
      await begin(page, url);
      await page.spot('Into the hall');
      await until(page, s => s.film && s.film.t > 0.5 && !s.film.paused, 20_000, 'the film to play');
      await page.pauseFromOutside();
      await sleep(800);
      const offered = await page.state();
      if (!offered.buttons.includes('▶ Play')) return { ok: false, detail: `paused from outside, the film offered ${JSON.stringify(offered.buttons)}: nothing plays it on` };
      await page.click('▶ Play');
      await until(page, s => atRest(s) && s.place === 'Hall', 15_000, '▶ Play to land the film');
      // Skip, after a pause from outside, lands the next film.
      await page.spot('Up the stairs');
      await until(page, s => s.film && s.film.t > 0.5 && !s.film.paused, 20_000, 'the next film to play');
      await page.pauseFromOutside();
      await sleep(800);
      await page.click('Skip ›');
      try { await until(page, s => atRest(s) && s.place === 'Roof', 10_000, 'Skip to land the film'); } catch { return { ok: false, detail: '▶ Play landed the film, but Skip after a pause from outside left the visitor stuck' }; }
      return { ok: true, detail: '▶ Play appeared and landed the film; Skip landed one paused from outside' };
    } finally { await page.close(); }
  },

  /** A film given up before its first frame stops downloading. */
  async 'give-up'(devtools, url) {
    const page = await openPage(devtools, { throttle: 1.5 });
    try {
      await begin(page, url);
      await page.spot('Up the ladder');
      await sleep(700); // Skip answers 600 ms after it appears
      const before = (await page.state()).check.reveals;
      await page.click('Skip ›');
      const skipped = Date.now();
      await until(page, s => atRest(s) && s.place === 'Roof', 60_000, 'the roof');
      if ((await page.state()).check.reveals !== before) return { ok: true, skipped: true, detail: 'the film reached its first frame before Skip; the give-up path was not reached (try again)' };
      await sleep(Math.max(0, skipped + 7000 - Date.now()));
      const after = page.bytes('yard-roof.mp4', skipped + 1000, skipped + 7000);
      const ok = after < 64 * 1024;
      return { ok, detail: ok ? `given up, the film stopped downloading (${after} bytes 1-7 s after Skip)` : `given up, the film went on downloading: ${(after / 1e6).toFixed(2)} MB 1-7 s after Skip` };
    } finally { await page.close(); }
  },

  /** Arriving does not fetch the Places panel's pictures while it is closed. */
  async panel(devtools, url) {
    const page = await openPage(devtools);
    try {
      await begin(page, url);
      await page.spot('Into the hall');
      await until(page, s => atRest(s) && s.place === 'Hall', 30_000, 'the hall');
      await sleep(1500);
      const roof = page.bytes('roof.png');
      return { ok: roof === 0, detail: roof === 0 ? 'two arrivals, and the roof\'s picture waits until someone heads there or opens Places'
        : `with the Places panel closed, two arrivals fetched the roof's picture (${(roof / 1e6).toFixed(2)} MB) before anyone headed there` };
    } finally { await page.close(); }
  },
};

// ── Run ─────────────────────────────────────────────────────────

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('check:player needs Google Chrome; set CHROME_PATH to its executable. Nothing was checked.');
    return 2;
  }
  let browser, server, failed = 0;
  try {
    const playerDir = values.player ? resolve(values.player) : join(root, 'player');
    if (!values.player) {
      console.log('Building the player…');
      const env = { ...process.env, PLAYER_OUT: playerDir };
      delete env.WORLD;
      delete env.VITE_DEFAULT_WORLD;
      const code = await runVite(['build', '--logLevel', 'warn'], { env });
      if (code !== 0) throw new Error(`the player build failed (${code})`);
    }
    console.log('Making the check\'s world…');
    await makeWorld(join(root, 'world'));
    server = await serve(playerDir, join(root, 'world'));
    browser = await launch(chrome);
    const probe = await openPage(browser.devtools);
    await probe.open(`${server.url}world/world.json`);
    const canPlay = await probe.evaluate(`document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')`);
    await probe.close();
    if (!canPlay) {
      console.log(`${chrome} cannot play H.264; check:player needs Google Chrome (CHROME_PATH). Nothing was checked.`);
      return 2;
    }
    const url = `${server.url}?world=${encodeURIComponent(`${server.url}world/world.json`)}`;
    for (const name of values.only ? values.only.split(',') : Object.keys(CHECKS)) {
      const check = CHECKS[name];
      if (!check) throw new Error(`no check called ${name} (${Object.keys(CHECKS).join(', ')})`);
      let result;
      try { result = await check(browser.devtools, url); } catch (error) { result = { ok: false, detail: error.message }; }
      if (!result.ok) failed++;
      console.log(`${result.ok ? (result.skipped ? '~' : '✓') : '✗'} ${name}: ${result.detail}`);
    }
    return failed ? 1 : 0;
  } finally {
    await browser?.close();
    server?.close();
    if (values.keep) console.log(`Kept ${root}`);
    else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

process.exitCode = await main();
