// The review page: only takes still waiting for your verdict, each film's takes
// side by side and frame-locked, the tapped one audible. Approve, reject or pass
// each take; judged takes disappear. Served by `node world review`.

/** The page for a set of films awaiting verdicts. Everything renders client-side from DATA. */
export function reviewPage({ title, token, films }) {
  const data = JSON.stringify({ title, token, films }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review — ${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1><span id="count"></span> <small>${escapeHtml(title)}</small></h1>
  <p class="how">Tap a film to play its group (the one you tap is the one you hear) · double-tap for full screen ·
  <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>S</kbd> seen, not chosen — on the take you are hearing ·
  <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> seek · <kbd>1</kbd>–<kbd>9</kbd> choose whose sound plays ·
  <kbd>M</kbd> mark an area on the frame you are watching (drag a box, say what you mean) · tap a start or end picture to mark it</p>
</header>
<main id="films"></main>
<div id="marker" hidden><div class="mk-panel">
  <p class="mk-title"></p>
  <div class="mk-stage"><img alt=""><div class="mk-old"></div><div class="mk-sel" hidden></div></div>
  <form class="mk-form"><input type="text" placeholder="Drag a box over the area, then say what you mean: “smoke from this house only”">
  <button type="submit" class="save">Save note</button><button type="button" class="cancel">Cancel</button></form>
  <p class="mk-msg"></p>
</div></div>
<p id="done" hidden>Nothing is waiting for you. Back in the terminal: <code>node world next</code></p>
<script>const DATA = ${data};</script>
<script>${SYNC_COMPARE}</script>
<script>${PAGE}</script>
</body>
</html>`;
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root { color-scheme: dark; --bg: #111316; --panel: #1b1e23; --line: #2c3139; --text: #e6e8eb; --dim: #9aa3ad; --accent: #4c8dff; --good: #3fb950; --bad: #f85149; --warn: #d29922; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header { padding: 16px 20px 4px; }
h1 { margin: 0; font-size: 20px; } h1 small { color: var(--dim); font-weight: 400; margin-left: 8px; }
.how { color: var(--dim); font-size: 13px; margin: 6px 0 0; }
kbd { border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; font: 12px ui-monospace, monospace; color: var(--text); }
main { padding: 0 20px 40px; }
#done { padding: 40px 20px; font-size: 18px; } code { background: var(--panel); padding: 2px 6px; border-radius: 4px; }
section.cmp { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 18px 0; }
.film-head { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; margin-bottom: 10px; }
.film-head .ends { display: flex; gap: 6px; align-items: center; color: var(--dim); font-size: 13px; }
.film-head .ends img { height: 64px; border-radius: 4px; display: block; }
.film-head .what { flex: 1 1 320px; min-width: 0; }
.film-head h2 { margin: 0 0 2px; font-size: 16px; }
.film-head .kind { color: var(--dim); font-size: 13px; }
.film-head .idea { margin: 6px 0 0; }
details { margin-top: 6px; } summary { cursor: pointer; color: var(--dim); font-size: 13px; }
details pre { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px; font-size: 12px; max-height: 320px; overflow: auto; }
.cmp-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--dim); font-size: 13px; margin-bottom: 10px; }
.cmp-bar button { font: inherit; padding: 3px 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); color: var(--text); cursor: pointer; }
.cmp-bar .hint b { color: var(--accent); }
.cmp-stage { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 12px; align-items: start; }
.cmp-stage:has(> .cmp-clip:only-child) { max-width: 1000px; }
.cmp-clip { margin: 0; min-width: 0; }
.cmp-clip figcaption { cursor: pointer; font-weight: 600; padding: 5px 8px; border-radius: 6px 6px 0 0; background: #262a31; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.cmp-clip figcaption .cmp-fs { font: inherit; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 4px; opacity: .75; }
.cmp-clip.audible figcaption { background: var(--accent); color: #fff; }
.cmp-clip.audible figcaption::after { content: 'Sound on'; font-weight: 600; white-space: nowrap; border: 1px solid currentColor; border-radius: 4px; padding: 0 6px; }
.cmp-clip.ref figcaption { background: #2d3a2a; }
.cmp-clip video { display: block; background: #000; width: 100%; height: auto; cursor: pointer; }
.cmp-clip video:fullscreen { width: 100vw; height: 100vh; object-fit: contain; }
.cmp-stage.native { display: flex; flex-wrap: nowrap; overflow-x: auto; }
.cmp-stage.native .cmp-clip { flex: 0 0 auto; } .cmp-stage.native .cmp-clip video { width: auto; max-width: none; }
.cmp-stage.flip { display: grid; grid-template-columns: 1fr; } .cmp-stage.flip .cmp-clip { grid-area: 1 / 1; visibility: hidden; } .cmp-stage.flip .cmp-clip.shown { visibility: visible; }
.take-panel { padding: 8px 2px 0; font-size: 13px; }
.meta { color: var(--dim); }
.flags { list-style: none; margin: 6px 0; padding: 0; }
.flags li { padding: 2px 0 2px 18px; position: relative; }
.flags li::before { content: '●'; position: absolute; left: 2px; font-size: 10px; top: 5px; }
.flags li.warn::before { color: var(--warn); } .flags li.error::before { color: var(--bad); } .flags li.clear::before { color: var(--good); } .flags li.note::before { color: var(--dim); }
.notes { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--text); }
.notes p { margin: 2px 0; } .notes .by { color: var(--dim); }
.judge { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.judge input { flex: 1 1 180px; min-width: 0; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: inherit; }
.judge button { font: inherit; font-weight: 600; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; color: #fff; }
.judge .approve { background: var(--good); } .judge .reject { background: var(--bad); } .judge .pass { background: #3a4150; }
.judge button:disabled { opacity: .5; cursor: wait; }
.sheet { display: inline-block; margin-top: 4px; color: var(--accent); }
.vbox { position: relative; display: block; width: fit-content; max-width: 100%; line-height: 0; }
.marks-layer { position: absolute; inset: 0; pointer-events: none; }
.mk { position: absolute; border: 2px solid #ff4d4d; border-radius: 3px; opacity: .3; transition: opacity .2s; }
.mk.now { opacity: 1; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
.mk b { position: absolute; top: -2px; left: -2px; background: #ff4d4d; color: #fff; font: 600 11px/16px -apple-system, sans-serif; padding: 0 5px; border-radius: 3px 0 3px 0; pointer-events: auto; cursor: pointer; }
.mark-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.mark-row button, .still-marks button { font: inherit; border: 1px solid #ff4d4d; color: #ffb3b3; background: transparent; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.areas { list-style: none; margin: 6px 0 0; padding: 0; width: 100%; }
.areas li { padding: 3px 6px; border-radius: 5px; cursor: pointer; } .areas li:hover { background: #262a31; }
.areas li .n { display: inline-block; min-width: 20px; text-align: center; background: #ff4d4d; color: #fff; border-radius: 3px; font-weight: 600; font-size: 11px; margin-right: 6px; }
.areas li .t { color: var(--dim); margin-right: 6px; }
.film-head .ends img { cursor: crosshair; }
.still-marks { width: 100%; font-size: 13px; }
#marker { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.86); display: flex; align-items: center; justify-content: center; padding: 16px; }
#marker[hidden] { display: none; }
.mk-panel { max-width: 96vw; display: flex; flex-direction: column; gap: 8px; }
.mk-title { margin: 0; color: var(--dim); font-size: 13px; }
.mk-stage { position: relative; line-height: 0; cursor: crosshair; user-select: none; touch-action: none; width: fit-content; }
.mk-stage img { display: block; max-width: 94vw; max-height: 74vh; -webkit-user-drag: none; }
.mk-old { position: absolute; inset: 0; pointer-events: none; }
.mk-sel { position: absolute; border: 2px dashed #fff; background: rgba(255,77,77,.18); box-shadow: 0 0 0 1px #000; pointer-events: none; }
.mk-form { display: flex; gap: 6px; }
.mk-form input { flex: 1; min-width: 0; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; font: inherit; }
.mk-form button { font: inherit; font-weight: 600; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; color: #fff; }
.mk-form .save { background: #ff4d4d; } .mk-form .cancel { background: #3a4150; }
.mk-msg { margin: 0; min-height: 1.2em; color: var(--warn); font-size: 13px; }
`;

// sync-compare, adapted for groups that change after a verdict: groups can be
// added and dropped, and the page asks which clip is audible. Rules: tapping a
// clip plays its whole group frame-locked and makes it the one heard; one group
// plays at a time; groups loop; clips are never covered (right-click → save).
const SYNC_COMPARE = `
window.syncCompare = (() => {
  const groups = [];
  let active = null;
  function initGroup(g) {
    const vids = [...g.querySelectorAll('video')];
    const clips = [...g.querySelectorAll('.cmp-clip')];
    const stage = g.querySelector('.cmp-stage');
    let master = vids[0];
    const pickMaster = () => { master = vids.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a), vids[0]); };
    vids.forEach(v => v.addEventListener('loadedmetadata', pickMaster));
    let loop = true, playing = false;
    const bar = g.querySelector('.cmp-bar');
    bar.innerHTML = '<button class="view" title="Flip view (F)">Flip view</button><button class="size" title="Native pixels (N)">Native pixels</button>'
      + '<span class="hint">Tap a film to hear it (its group plays together) · tap the one you hear to pause · double-tap for full screen'
      + (vids.length > 1 ? ' · sound: <b class="aud"></b>' : '') + '</span>';
    const $ = s => bar.querySelector(s);
    vids.forEach(v => { v.controls = false; v.playsInline = true; v.loop = false; v.preload = 'auto'; });
    function setAudio(i) {
      if (!Number.isInteger(i) || i < 0 || i >= vids.length) return;
      vids.forEach(v => { v.muted = true; });
      vids[i].muted = false;
      clips.forEach((c, j) => { c.classList.toggle('audible', j === i); c.classList.toggle('shown', j === i); });
      const aud = $('.aud'); if (aud) aud.textContent = clips[i].querySelector('figcaption').dataset.clipLabel;
    }
    const seek = t => vids.forEach(v => { v.currentTime = t; });
    async function play() {
      for (const other of groups) if (other !== api) { other.pause(); other.videos.forEach(v => { v.muted = true; }); other.section.querySelectorAll('.cmp-clip').forEach(c => c.classList.remove('audible')); }
      if (master.ended || master.currentTime >= master.duration - 0.02) seek(0);
      playing = true; g.classList.add('playing');
      const heard = Math.max(0, clips.findIndex(c => c.classList.contains('audible')));
      setAudio(heard);
      const ok = await Promise.all(vids.map(v => v.play().then(() => true, () => false)));
      if (ok.some(x => !x)) {
        // The browser refused sound before any tap: play silently until the first tap turns a clip's sound on.
        vids.forEach(v => { v.muted = true; }); clips.forEach(c => c.classList.remove('audible'));
        const aud = $('.aud'); if (aud) aud.textContent = 'tap a film';
        await Promise.all(vids.map(v => v.play().catch(() => {})));
      }
      requestAnimationFrame(tick);
    }
    function pause() { if (!playing) return; playing = false; g.classList.remove('playing'); vids.forEach(v => v.pause()); seek(master.currentTime); }
    function tick() {
      if (!playing) return;
      const t = master.currentTime;
      for (const v of vids) {
        if (v === master) continue;
        if (t >= (v.duration || Infinity) - 0.05) continue;
        if (v.paused && !v.ended) v.play().catch(() => {});
        const drift = v.currentTime - t;
        if (Math.abs(drift) > 0.25) { v.currentTime = t; v.playbackRate = 1; }
        else v.playbackRate = 1 - Math.max(-0.1, Math.min(0.1, drift * 2));
      }
      requestAnimationFrame(tick);
    }
    vids.forEach(v => v.addEventListener('ended', () => { if (v !== master) return; if (loop) { seek(0); vids.forEach(w => w.play().catch(() => {})); } else pause(); }));
    const toggleView = () => { stage.classList.toggle('flip'); $('.view').textContent = stage.classList.contains('flip') ? 'Side by side' : 'Flip view'; };
    const toggleSize = () => {
      const native = stage.classList.toggle('native');
      vids.forEach(v => { v.style.width = native ? (v.videoWidth / devicePixelRatio) + 'px' : ''; v.style.height = native ? (v.videoHeight / devicePixelRatio) + 'px' : ''; });
      $('.size').textContent = native ? 'Fit to window' : 'Native pixels';
    };
    let tapTimer = null;
    vids.forEach((v, i) => {
      v.addEventListener('click', e => {
        e.preventDefault(); active = api;
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; return; }
        const heard = playing && !vids[i].muted;
        setAudio(i);
        tapTimer = setTimeout(() => { tapTimer = null; if (!playing) play(); else if (heard) pause(); }, 220);
      });
      v.addEventListener('dblclick', e => { e.preventDefault(); active = api; setAudio(i); if (document.fullscreenElement) document.exitFullscreen(); else (v.requestFullscreen ? v.requestFullscreen() : v.webkitEnterFullscreen && v.webkitEnterFullscreen()); });
    });
    clips.forEach((c, i) => {
      const cap = c.querySelector('figcaption');
      cap.dataset.clipLabel = cap.textContent.trim();
      const fs = document.createElement('button'); fs.className = 'cmp-fs'; fs.type = 'button'; fs.title = 'Full screen'; fs.textContent = '⛶';
      fs.addEventListener('click', e => { e.stopPropagation(); active = api; setAudio(i); vids[i].requestFullscreen ? vids[i].requestFullscreen() : vids[i].webkitEnterFullscreen && vids[i].webkitEnterFullscreen(); });
      cap.appendChild(fs);
      cap.addEventListener('click', () => { active = api; setAudio(i); });
    });
    $('.view').addEventListener('click', toggleView);
    $('.size').addEventListener('click', toggleSize);
    g.addEventListener('pointerenter', () => { active = api; });
    g.addEventListener('pointerdown', () => { active = api; });
    setAudio(Math.max(0, clips.findIndex(c => !c.classList.contains('ref'))));
    const api = {
      section: g, videos: vids, clips, play, pause, isPlaying: () => playing,
      toggle: () => (playing ? pause() : play()),
      seekBy: dt => seek(Math.min(master.duration || 0, Math.max(0, master.currentTime + dt))),
      seekTo: t => seek(Math.min(master.duration || 0, Math.max(0, t))),
      restart: () => seek(0), setAudio: i => i < vids.length && setAudio(i), toggleView, toggleSize,
      toggleLoop: () => { loop = !loop; },
      audible: () => clips.find(c => c.classList.contains('audible')) || null,
    };
    return api;
  }
  const visible = api => api.section.isConnected && api.section.offsetParent !== null;
  function next() {
    if (groups.some(api => api.isPlaying() && visible(api))) return;
    const api = groups.find(visible);
    if (!api) return;
    active = api;
    const start = () => api.play();
    if (api.videos[0].readyState >= 2) start(); else api.videos[0].addEventListener('loadeddata', start, { once: true });
  }
  function add(section) { const api = initGroup(section); groups.push(api); return api; }
  function drop(section) {
    const i = groups.findIndex(api => api.section === section);
    if (i < 0) return;
    groups[i].pause();
    groups[i].videos.forEach(v => { v.removeAttribute('src'); v.load(); });
    if (active === groups[i]) active = null;
    groups.splice(i, 1);
  }
  document.addEventListener('keydown', e => {
    if (!active || (e.target instanceof Element && e.target.closest('input, textarea, button')) || !document.getElementById('marker').hidden) return;
    if (e.key === ' ') { e.preventDefault(); active.toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); active.seekBy(-0.5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); active.seekBy(0.5); }
    else if (e.key === 'Home') { e.preventDefault(); active.restart(); }
    else if (/^[1-9]$/.test(e.key)) active.setAudio(Number(e.key) - 1);
    else if (e.key === 'f' || e.key === 'F') active.toggleView();
    else if (e.key === 'n' || e.key === 'N') active.toggleSize();
    else if (e.key === 'l' || e.key === 'L') active.toggleLoop();
  });
  return { groups, add, drop, next, active: () => active };
})();
`;

const PAGE = `
(() => {
  const main = document.getElementById('films');
  const films = DATA.films;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const awaiting = () => films.reduce((n, f) => n + f.takes.length, 0);
  function updateCount() {
    const n = awaiting();
    document.getElementById('count').textContent = n ? n + (n === 1 ? ' take awaits you' : ' takes await you') : 'All judged';
    document.title = (n ? '(' + n + ') ' : '') + 'Review — ' + DATA.title;
    document.getElementById('done').hidden = n > 0;
  }
  function flagList(take) {
    if (!take.screened) return '<ul class="flags"><li class="warn">Not screened yet — run <code>node world screen</code></li></ul>';
    if (!take.flags.length) return '<ul class="flags"><li class="clear">Screening flagged nothing (it still needs eyes)</li></ul>';
    return '<ul class="flags">' + take.flags.map(f => '<li class="' + esc(f.severity) + '">' + esc(f.message) + '</li>').join('') + '</ul>';
  }
  const areaNotes = list => (list || []).filter(n => n.box);
  function notes(take) {
    const plain = take.notes.filter(n => !n.box);
    if (!plain.length) return '';
    return '<div class="notes">' + plain.map(n => '<p><span class="by">' + esc(n.by) + ':</span> ' + esc(n.text) + '</p>').join('') + '</div>';
  }
  function figure(film, take) {
    return '<figure class="cmp-clip" data-sha="' + esc(take.sha) + '">'
      + '<figcaption>Take ' + take.take + '</figcaption>'
      + '<div class="vbox"><video src="' + esc(take.url) + '" preload="auto" playsinline></video><div class="marks-layer"></div></div>'
      + '<div class="take-panel"><div class="meta">' + esc(take.meta) + '</div>' + flagList(take) + notes(take)
      + (take.sheet ? '<a class="sheet" href="' + esc(take.sheet) + '" target="_blank" rel="noopener">Contact sheet</a>' : '')
      + '<div class="mark-row"><button type="button" class="mark" title="Pause here and drag a box over what you mean (M)">Mark an area</button><ul class="areas"></ul></div>'
      + '<div class="judge"><input type="text" placeholder="Note (optional): what you saw, what to change">'
      + '<button class="approve" data-verdict="approved">Approve</button>'
      + '<button class="reject" data-verdict="rejected">Reject</button>'
      + '<button class="pass" data-verdict="passed" title="Seen; not the one">Seen</button></div></div>'
      + '</figure>';
  }
  function render(film) {
    const section = document.createElement('section');
    section.className = 'cmp';
    section.dataset.film = film.id;
    const pic = (url, place, which) => '<img src="' + esc(url) + '" alt="" data-place="' + esc(place) + '" title="Mark an area on the ' + which + ' picture">';
    const ends = (film.fromStill ? pic(film.fromStill, film.fromPlace, film.kind === 'crossing' ? 'start' : 'place') : '')
      + (film.kind === 'crossing' ? '→' + (film.toStill ? pic(film.toStill, film.toPlace, 'end') : '') : '');
    section.innerHTML = '<div class="film-head"><div class="ends">' + ends + '</div><div class="what">'
      + '<h2>' + esc(film.label || film.id) + '</h2>'
      + '<div class="kind">' + esc(film.id) + ' · ' + esc(film.kindText) + '</div>'
      + (film.idea ? '<p class="idea">' + esc(film.idea) + '</p>' : '')
      + (film.prompt ? '<details><summary>Exact prompt sent to the model</summary><pre>' + esc(film.prompt) + '</pre></details>' : '')
      + '</div><div class="still-marks"></div></div><div class="cmp-bar"></div><div class="cmp-stage">'
      + (film.ref ? '<figure class="cmp-clip ref"><figcaption>REF · approved take ' + film.ref.take + '</figcaption><video src="' + esc(film.ref.url) + '" preload="auto" playsinline></video></figure>' : '')
      + film.takes.map(take => figure(film, take)).join('')
      + '</div>';
    section.querySelectorAll('.judge button').forEach(button => button.addEventListener('click', () => judge(section, button)));
    section.querySelectorAll('figure[data-sha]').forEach(fig => {
      const take = film.takes.find(t => t.sha === fig.dataset.sha);
      const video = fig.querySelector('video');
      fig.querySelector('.mark').addEventListener('click', () => markTake(section, fig, take));
      const now = () => fig.querySelectorAll('.mk').forEach(m => m.classList.toggle('now', Math.abs(Number(m.dataset.time) - video.currentTime) < 0.75));
      video.addEventListener('timeupdate', now); video.addEventListener('seeked', now);
      paintTake(section, fig, take);
    });
    section.querySelectorAll('.film-head .ends img[data-place]').forEach(img => img.addEventListener('click', () => markStill(section, film, img)));
    paintStills(section, film);
    return section;
  }
  // Area notes: drag a box over a paused frame (or a start/end picture) and say what you mean.
  const boxCss = b => 'left:' + (b[0] * 100) + '%;top:' + (b[1] * 100) + '%;width:' + (b[2] * 100) + '%;height:' + (b[3] * 100) + '%';
  const groupOf = section => window.syncCompare.groups.find(api => api.section === section);
  function paintTake(section, fig, take) {
    const marks = areaNotes(take.notes);
    fig.querySelector('.marks-layer').innerHTML = marks.map((n, i) => '<div class="mk" data-time="' + (n.time ?? -9) + '" style="' + boxCss(n.box) + '"><b data-i="' + i + '">' + (i + 1) + '</b></div>').join('');
    fig.querySelector('.areas').innerHTML = marks.map((n, i) => '<li data-i="' + i + '"><span class="n">' + (i + 1) + '</span>'
      + (n.time != null ? '<span class="t">' + Number(n.time).toFixed(1) + ' s</span>' : '') + esc(n.text) + '</li>').join('');
    const seekTo = i => { const api = groupOf(section); if (!api || marks[i].time == null) return; api.pause(); api.seekTo(marks[i].time); };
    fig.querySelectorAll('.areas li, .mk b').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); seekTo(Number(el.dataset.i)); }));
    const input = fig.querySelector('.judge input');
    input.placeholder = marks.length ? 'Note (optional) — your ' + marks.length + ' area note' + (marks.length === 1 ? ' is' : 's are') + ' saved with this take' : 'Note (optional): what you saw, what to change';
  }
  function paintStills(section, film) {
    const rows = [];
    for (const [place, list] of Object.entries(film.stillNotes || {})) areaNotes(list).forEach((n, i) => rows.push('<li><span class="n">' + (i + 1) + '</span><span class="t">' + esc(place) + ' picture</span>' + esc(n.text) + '</li>'));
    section.querySelector('.still-marks').innerHTML = rows.length ? '<ul class="areas">' + rows.join('') + '</ul>' : '';
  }
  async function postMark(body) {
    const response = await fetch('/mark', { method: 'POST', headers: { 'content-type': 'application/json', 'x-review-token': DATA.token }, body: JSON.stringify(body) });
    if (!response.ok) return { error: await response.text() };
    return { note: await response.json() };
  }
  function markTake(section, fig, take) {
    const api = groupOf(section);
    if (api) api.pause();
    const video = fig.querySelector('video');
    const time = video.currentTime;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    openMarker({
      src: canvas.toDataURL('image/jpeg', 0.9),
      title: 'Take ' + take.take + ' at ' + time.toFixed(1) + ' s — drag a box over what you mean',
      existing: areaNotes(take.notes).filter(n => n.time == null || Math.abs(n.time - time) < 0.75),
      save: async (box, text) => {
        const { note, error } = await postMark({ sha: take.sha, time, box, text });
        if (error) return error;
        take.notes.push(note); paintTake(section, fig, take); return null;
      },
    });
  }
  function markStill(section, film, img) {
    const place = img.dataset.place;
    openMarker({
      src: img.src,
      title: 'The ' + place + ' picture — drag a box over what you mean',
      existing: areaNotes((film.stillNotes || {})[place]),
      save: async (box, text) => {
        const { note, error } = await postMark({ still: place, box, text });
        if (error) return error;
        ((film.stillNotes ||= {})[place] ||= []).push(note); paintStills(section, film); return null;
      },
    });
  }
  function openMarker({ src, title, existing, save }) {
    const root = document.getElementById('marker');
    const stage = root.querySelector('.mk-stage'), sel = root.querySelector('.mk-sel'), input = root.querySelector('input'), msg = root.querySelector('.mk-msg');
    root.querySelector('.mk-title').textContent = title;
    stage.querySelector('img').src = src;
    root.querySelector('.mk-old').innerHTML = existing.map(n => '<div class="mk now" style="' + boxCss(n.box) + '"></div>').join('');
    let box = null, start = null;
    sel.hidden = true; input.value = ''; msg.textContent = '';
    const at = e => { const r = stage.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
    const draw = b => { sel.hidden = false; sel.style.cssText = boxCss(b); };
    stage.onpointerdown = e => { e.preventDefault(); stage.setPointerCapture(e.pointerId); start = at(e); box = null; draw([start[0], start[1], 0, 0]); };
    stage.onpointermove = e => { if (!start) return; const p = at(e); box = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])]; draw(box); };
    stage.onpointerup = () => { start = null; if (box && (box[2] < 0.01 || box[3] < 0.01)) { box = null; sel.hidden = true; } if (box) input.focus(); };
    const close = () => { root.hidden = true; document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.cancel').onclick = close;
    root.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      if (!box) { msg.textContent = 'Drag a box over the area first.'; return; }
      if (!input.value.trim()) { msg.textContent = 'Say what you mean about this area.'; input.focus(); return; }
      msg.textContent = 'Saving…';
      const error = await save(box, input.value.trim());
      if (error) { msg.textContent = 'Could not save: ' + error; return; }
      close();
    };
    root.hidden = false;
  }
  async function judge(section, button) {
    const fig = button.closest('figure');
    const film = films.find(f => f.id === section.dataset.film);
    const sha = fig.dataset.sha;
    const verdict = button.dataset.verdict;
    const note = fig.querySelector('.judge input').value.trim();
    fig.querySelectorAll('.judge button').forEach(b => { b.disabled = true; });
    const response = await fetch('/verdict', { method: 'POST', headers: { 'content-type': 'application/json', 'x-review-token': DATA.token }, body: JSON.stringify({ sha, verdict, note }) });
    if (!response.ok) {
      fig.querySelectorAll('.judge button').forEach(b => { b.disabled = false; });
      fig.querySelector('.meta').textContent = 'Could not save: ' + (await response.text());
      return;
    }
    // Approving one take settles the film: its other takes are marked seen.
    film.takes = verdict === 'approved' ? [] : film.takes.filter(t => t.sha !== sha);
    const wasPlaying = window.syncCompare.groups.some(api => api.section === section && api.isPlaying());
    window.syncCompare.drop(section);
    if (film.takes.length) {
      const fresh = render(film);
      section.replaceWith(fresh);
      const api = window.syncCompare.add(fresh);
      if (wasPlaying) api.play();
    } else {
      section.remove();
      films.splice(films.indexOf(film), 1);
      window.syncCompare.next();
    }
    updateCount();
  }
  for (const film of films) { const section = render(film); main.appendChild(section); window.syncCompare.add(section); }
  updateCount();
  document.addEventListener('keydown', e => {
    if (e.target instanceof Element && e.target.closest('input, textarea, button')) return;
    if (!document.getElementById('marker').hidden) return;
    const key = e.key.toLowerCase();
    if (!['a', 'r', 's', 'm'].includes(key)) return;
    const api = window.syncCompare.active();
    const clip = api && api.audible();
    if (!clip || clip.classList.contains('ref')) return;
    if (key === 'm') { e.preventDefault(); clip.querySelector('.mark').click(); return; }
    const button = clip.querySelector('.judge .' + ({ a: 'approve', r: 'reject', s: 'pass' })[key]);
    if (button && !button.disabled) { e.preventDefault(); button.click(); }
  });
  if (document.readyState === 'complete') window.syncCompare.next(); else addEventListener('load', () => window.syncCompare.next(), { once: true });
})();
`;
