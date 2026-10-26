// Delivery: the formats a finished world is served in, and the check that every
// file it serves meets them. `build` and `export` both run the check and stop
// on a failure, so nothing outside these formats reaches a host.
//
//   stills   WebP (quality 84, sharp YUV), at their own pixel size, never
//            enlarged, metadata stripped
//   films    H.264 through Sogni's streaming profile (the one Sogni's own
//            worlds use): CRF 23, the bitrate capped by the picture's short
//            edge, a keyframe every 2 s, yuv420p, the index at the front
//   social   one JPEG card, 1200 × 630 (crawlers do not all read WebP)
//   PNG      icons only (512 px or less). The PNGs the pipeline keeps
//            (generations, masks, push-in frames) are never served.
//
// Format guide: docs/hosting.md › What a world serves.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { FFPROBE, run } from './media.js';
import { mediaEntries, isRemote } from './worldjson.js';

export const CRF = 23;
export const GOP_SECONDS = 2;
/** Served stills (and figure icons, with their transparency kept exact). */
export const WEBP = Object.freeze({ quality: 84, smartSubsample: true, effort: 6 });
/** The card a link to the world shows on social sites and in the Sogni gallery. */
export const SOCIAL = Object.freeze({ file: 'social.jpg', width: 1200, height: 630, quality: 85 });
/** The largest PNG that still counts as an icon. */
export const ICON_MAX = 512;
/** How far over the cap a film may measure before it fails (the encoder lands just under it). */
const TOLERANCE = 0.05;

/**
 * The bitrate cap by the short edge, with a buffer of twice the cap: up to
 * 768 px 4.5 Mbps, up to 1080 px 8 Mbps, above that (2K) 12 Mbps.
 */
export const bitrateProfile = (width, height) => Math.min(width, height) <= 768
  ? { name: '768p', maxrate: 4_500_000, bufsize: 9_000_000 }
  : Math.min(width, height) <= 1080
    ? { name: '1080p', maxrate: 8_000_000, bufsize: 16_000_000 }
    : { name: '2K', maxrate: 12_000_000, bufsize: 24_000_000 };

/** The x264 settings for a served film of this size and frame rate. */
export function videoArgs({ width, height, fps = 24 }) {
  const { maxrate, bufsize } = bitrateProfile(width, height);
  return ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(CRF), '-maxrate', String(maxrate), '-bufsize', String(bufsize),
    '-g', String(Math.max(1, Math.round((fps || 24) * GOP_SECONDS))), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
}

/** A served still from a canonical one: the same pixels, as WebP, metadata stripped. */
export const writeServedStill = (source, target) => sharp(source, { failOn: 'error' }).webp(WEBP).toFile(target);

/** A figure's icon from its cutout: at most 320 px, transparency exact. */
export const writeIcon = (cutout, target) => sharp(cutout).resize(320, 320, { fit: 'inside', withoutEnlargement: true })
  .webp({ ...WEBP, alphaQuality: 100 }).toFile(target);

/** The social card: the opening still filling 1200 × 630, as JPEG. */
export const writeSocialCard = (still, target) => sharp(still).resize(SOCIAL.width, SOCIAL.height, { fit: 'cover', kernel: 'lanczos3' })
  .jpeg({ quality: SOCIAL.quality, mozjpeg: true }).toFile(target);

/** Sound every browser plays, served as it is. Anything else (WAV, AIFF, Ogg) build transcodes to MP3. */
export const WEB_AUDIO = ['.mp3', '.m4a', '.aac', '.flac'];

/** Does an MP4 keep its index (moov) ahead of the media (mdat), so it can start before it has all arrived? */
export async function fastStart(path) {
  const handle = await open(path);
  try {
    const header = Buffer.alloc(16);
    for (let offset = 0, n = 0; n < 100; n++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      let size = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (size === 1) size = Number(header.readBigUInt64BE(8));
      if (size < 8) return false;
      offset += size;
    }
    return false;
  } finally { await handle.close(); }
}

/**
 * How a film streams: codec, size, the bitrate on average and at its busiest,
 * the longest stretch between keyframes, and whether it stays inside its cap.
 * "Inside the cap" is the cap's own rule: no stretch of the film carries more
 * than the cap for that long plus the buffer (twice the cap), so a visitor on
 * a link at the cap never waits once playing has begun.
 */
export async function measureFilm(path) {
  const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,pix_fmt,width,height,r_frame_rate:packet=pts_time,dts_time,size,flags:format=format_name,duration', '-of', 'json', path], { maxBuffer: 64 << 20 });
  const data = JSON.parse(out.toString('utf8'));
  const video = data.streams?.[0] ?? {};
  const [num, den] = String(video.r_frame_rate ?? '24/1').split('/').map(Number);
  const fps = den ? num / den : 24;
  const packets = (data.packets ?? []).map(p => ({ dts: Number(p.dts_time ?? p.pts_time), pts: Number(p.pts_time ?? p.dts_time), bits: Number(p.size) * 8, key: String(p.flags).includes('K') }))
    .filter(p => Number.isFinite(p.dts) && Number.isFinite(p.pts));
  const profile = bitrateProfile(video.width ?? 0, video.height ?? 0);
  const result = { codec: video.codec_name, pixFmt: video.pix_fmt, width: video.width, height: video.height, fps, profile,
    container: data.format?.format_name ?? '', fastStart: await fastStart(path), averageBps: 0, busiestSecondBps: 0, longestGop: Infinity, withinCap: false };
  if (!packets.length) return result;
  packets.sort((a, b) => a.dts - b.dts);
  const first = Math.min(...packets.map(p => p.pts));
  const seconds = Math.max(...packets.map(p => p.pts)) - first + 1 / fps;
  result.averageBps = packets.reduce((sum, p) => sum + p.bits, 0) / seconds;
  for (let i = 0, j = 0, sum = 0; i < packets.length; i++) {
    while (j < packets.length && packets[j].dts < packets[i].dts + 1 - 1e-6) sum += packets[j++].bits;
    result.busiestSecondBps = Math.max(result.busiestSecondBps, sum);
    sum -= packets[i].bits;
  }
  // The longest stretch a visitor seeking (or a player switching size) waits for a keyframe, start and end included.
  const keys = packets.filter(p => p.key).map(p => p.pts - first).sort((a, b) => a - b);
  if (keys.length) result.longestGop = Math.max(keys[0], seconds - keys.at(-1), ...keys.slice(1).map((t, i) => t - keys[i]));
  // The cap's buffer, full when playing starts, filled at the cap and drained by every frame as it is decoded.
  const depth = profile.bufsize * (1 + TOLERANCE);
  let level = depth, then = packets[0].dts, low = depth;
  for (const p of packets) {
    level = Math.min(depth, level + (p.dts - then) * profile.maxrate);
    then = p.dts;
    level -= p.bits;
    low = Math.min(low, level);
  }
  result.withinCap = low >= 0;
  return result;
}

const mbps = bps => `${(bps / 1e6).toFixed(1)} Mbps`;

/** What keeps a served film from streaming as Sogni's profile says; an empty list means it is fine. */
export async function filmIssues(path, where) {
  const m = await measureFilm(path);
  const issues = [];
  if (!/mp4/.test(m.container) || extname(path).toLowerCase() !== '.mp4') issues.push(`${where}: is not an MP4`);
  if (m.codec !== 'h264') issues.push(`${where}: is ${m.codec ?? 'not video'}, not H.264`);
  if (m.pixFmt && m.pixFmt !== 'yuv420p') issues.push(`${where}: is ${m.pixFmt}, not yuv420p`);
  if (!m.fastStart) issues.push(`${where}: its index is at the end (no fast start), so it cannot play until it has all arrived`);
  if (m.longestGop > GOP_SECONDS + 1 / m.fps + 1e-3) issues.push(`${where}: ${Number.isFinite(m.longestGop) ? `${m.longestGop.toFixed(2)} s` : 'no keyframe'} between keyframes (at most ${GOP_SECONDS} s)`);
  if (m.averageBps > m.profile.maxrate * (1 + TOLERANCE)) issues.push(`${where}: averages ${mbps(m.averageBps)}, over the ${mbps(m.profile.maxrate)} cap for a ${m.width}×${m.height} film`);
  else if (!m.withinCap) issues.push(`${where}: bursts past the ${mbps(m.profile.maxrate)} cap for a ${m.width}×${m.height} film (its busiest second carries ${mbps(m.busiestSecondBps)}): it was encoded without the cap`);
  return issues;
}

/** What keeps a served picture from its format; an empty list means it is fine. */
export async function imageIssues(path, where, { icon = false } = {}) {
  if (extname(path).toLowerCase() === '.svg') return icon ? [] : [`${where}: an SVG is not a still; stills ship as WebP`];
  let meta;
  try { meta = await sharp(path).metadata(); } catch { return [`${where}: is not a picture a browser can show`]; }
  const issues = [];
  if (icon) {
    if (meta.format === 'png' && Math.max(meta.width, meta.height) > ICON_MAX) issues.push(`${where}: a ${meta.width}×${meta.height} PNG; PNG is for icons of ${ICON_MAX} px or less: ship it as WebP`);
    else if (!['png', 'webp', 'jpeg', 'svg'].includes(meta.format)) issues.push(`${where}: is ${meta.format}; ship it as WebP`);
  } else if (meta.format !== 'webp') {
    issues.push(`${where}: is ${meta.format === 'jpeg' ? 'JPEG' : meta.format.toUpperCase()}; stills ship as WebP`);
  }
  if (meta.exif || meta.xmp) issues.push(`${where}: carries camera metadata (EXIF/XMP, which can include where it was taken); strip it`);
  return issues;
}

/** What keeps served sound from streaming well; an empty list means it is fine. */
export async function audioIssues(path, where) {
  let codec = '';
  try {
    const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path]);
    codec = out.toString('utf8').trim();
  } catch { return [`${where}: is not sound a browser can play`]; }
  if (!codec) return [`${where}: has no sound`];
  if (codec.startsWith('pcm_')) return [`${where}: is uncompressed (${codec}); ship it as MP3 or AAC`];
  return [];
}

/**
 * Check every file a world serves from `dir` (its build folder or an export)
 * against the formats above. Returns { issues, remote }: `issues` is what has
 * to change before the world is hosted, `remote` the media streamed from other
 * hosts, which cannot be checked or fixed here (named with any PNG among them).
 */
export async function deliveryIssues(world, dir) {
  const remote = { count: 0, png: [] };
  const seen = new Set();
  const checks = [];
  for (const { ref, kind, where } of mediaEntries(world)) {
    if (isRemote(ref)) {
      remote.count++;
      if (kind !== 'icon' && /\.png(\?|#|$)/i.test(ref)) remote.png.push(ref);
      continue;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    const path = resolve(dir, ref);
    if (!path.startsWith(resolve(dir) + sep)) { checks.push(async () => [`${where}: ${ref} points outside the world's folder`]); continue; }
    if (!existsSync(path)) { checks.push(async () => [`${where}: ${ref} is missing`]); continue; }
    const label = `${ref} (${where})`;
    if (kind === 'film') checks.push(() => filmIssues(path, label));
    else if (kind === 'still') checks.push(() => imageIssues(path, label));
    else if (kind === 'icon') checks.push(() => imageIssues(path, label, { icon: true }));
    else if (kind === 'audio') checks.push(() => audioIssues(path, label));
  }
  // A few at a time: a large world has hundreds of films, each a quick ffprobe.
  const found = new Array(checks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, checks.length) }, async () => {
    while (next < checks.length) { const i = next++; found[i] = await checks[i](); }
  }));
  return { issues: found.flat(), remote };
}

/** Every PNG in a folder that is served (an export: everything in it is) and is not one of the world's icons. */
export function strayPngs(world, dir) {
  const icons = new Set(mediaEntries(world).filter(e => e.kind === 'icon' && !isRemote(e.ref)).map(e => resolve(dir, e.ref)));
  return walk(dir).filter(file => extname(file).toLowerCase() === '.png' && !icons.has(file))
    .map(file => `${relative(dir, file).split(sep).join('/')}: a PNG that is not an icon; served pictures ship as WebP`);
}

/** The one line that says how to put things right. */
export const DELIVERY_FIX = 'Run node world build: it encodes every film through the streaming profile and writes every still as WebP (--force redoes them all). A file you placed by hand: convert it (docs/hosting.md › What a world serves).';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (statSync(path).isFile()) out.push(path);
  }
  return out;
}
