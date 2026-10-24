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
//
//   npm run check:player                 builds the player and runs every check
//   node test/player-playback.mjs --player <dir> [--only join,pause]
//
// Needs Google Chrome (H.264 films); CHROME_PATH points at another. It drives
// headless Chrome over the DevTools protocol with Node's own WebSocket, so the
// kit needs no browser package. Not part of `npm test`: it needs a browser.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { ffmpeg } from '../cli/lib/media.js';
import { runVite } from '../cli/lib/player.js';
import { validateWorld } from '../cli/lib/worldjson.js';

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
async function openPage(devtools, { throttle = null } = {}) {
  const { browserContextId } = await devtools.send('Target.createBrowserContext');
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => devtools.send(method, params, sessionId);
  const requests = new Map();
  const loaded = new Set();
  devtools.on(message => {
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { url: params.request.url, type: params.type, received: [] });
    else if (method === 'Network.dataReceived') requests.get(params.requestId)?.received.push([Date.now(), params.encodedDataLength || params.dataLength]);
    else if (method === 'Network.loadingFinished') { const r = requests.get(params.requestId); if (r) r.finished = true; }
    else if (method === 'Page.loadEventFired') loaded.add(true);
  });
  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
  if (throttle) await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: throttle * 125_000, uploadThroughput: throttle * 125_000 });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const page = {
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
        film: film ? { t: film.currentTime, paused: film.paused, ended: film.ended } : null, buttons, check: window.__check };
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
        hotspots: [spot('door', 'Into the hall', 'hall', 'yard-hall', [0.3, 0.5]), spot('ladder', 'Up the ladder', 'roof', 'yard-roof', [0.7, 0.5])] },
      { id: 'hall', title: 'Hall', still: 'stills/hall.png', hotspots: [spot('stairs', 'Up the stairs', 'roof', 'hall-roof', [0.5, 0.5])] },
      { id: 'roof', title: 'Roof', still: 'stills/roof.png', loop: { src: 'films/roof-loop.mp4' }, hotspots: [spot('down', 'Back down', 'yard', 'roof-yard', [0.5, 0.5])] },
    ],
  };
  const issues = validateWorld(world);
  if (issues.length) throw new Error(`the check's world is not valid: ${issues.join('; ')}`);
  writeFileSync(join(dir, 'world.json'), JSON.stringify(world, null, 2));
}

/** The player at /, the world at /world/, with byte ranges (video seeks need them). */
function serve(playerDir, worldDir) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const [base, rel] = path.startsWith('/world/') ? [worldDir, path.slice(7)] : [playerDir, path.slice(1) || 'index.html'];
    const file = resolve(base, rel);
    if (!file.startsWith(resolve(base) + sep) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    const size = statSync(file).size;
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
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
