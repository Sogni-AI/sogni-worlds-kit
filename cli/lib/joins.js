// Joins: every hard cut in a stitched film, shown frame by frame on both sides, plus a dense sheet of every shot.
//
// A stitched film (a trailer, a preview loop, a multi-shot scene, a recut) breaks where its shots meet: a character
// on the wrong side, a prop that vanishes, a car that changes model or loses a passenger, an eyeline that points
// at the wrong person, traffic that flips direction, a light that jumps. None of it shows on eight frames spread
// over the film. Mark, 2026-11-02: judging from "a handful of frames" is "a major major major detriment to quality".
//
//   joinsReport(video, { out, at })  ->  { cuts, shots, sheets, frames }  (and the files below in `out`)
//     joins-<page>.jpg     one row per cut: the 3 frames before it | the 3 frames after it
//     cut-<k>-before.jpg   the last frame before cut k, full size
//     cut-<k>-after.jpg    the first frame after cut k (after any flash or dissolve), full size
//     shot-<k>.jpg         every shot: 12 frames over it, 6 across
//     joins.json           cut frames and times, shot spans
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { probe } from './media.js';
import { analyseFrames, framesAt, greyFrames } from './screen.js';

const CUTS_PER_PAGE = 8;
const SIDE = 3;
const SHOT_FRAMES = 12;

/** Hard cuts found by the screener's own cut test (a jump far above the motion around it), as first frames of new shots. */
export async function findCuts(video) {
  const { flags } = analyseFrames(await greyFrames(video), { kind: 'crossing' });
  return [...new Set(flags.filter(flag => flag.code === 'hard-cut').map(flag => flag.frame))].sort((a, b) => a - b);
}

/** Jumps within 6 frames of each other are one join (a flash, a whip or a short dissolve): { from, to } frames. */
export function joinsOf(cuts) {
  const out = [];
  for (const frame of cuts) {
    const last = out[out.length - 1];
    if (last && frame - last.to <= 6) last.to = frame; else out.push({ from: frame, to: frame });
  }
  return out;
}

const label = (text, width, height = 28) => Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="black" fill-opacity="0.65"/><text x="8" y="${height - 8}" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="white">${text}</text></svg>`);

async function sheet(path, rows, tileWidth, tileHeight, columns, divider = null) {
  const composite = [];
  rows.forEach((row, r) => row.forEach((tile, c) => {
    if (!tile) return;
    const left = c * tileWidth + (divider !== null && c >= divider ? 12 : 0), top = r * tileHeight;
    composite.push({ input: tile.image, left, top });
    composite.push({ input: label(tile.text, tileWidth), left, top });
  }));
  const width = tileWidth * columns + (divider !== null ? 12 : 0), height = tileHeight * rows.length;
  if (divider !== null) composite.push({ input: { create: { width: 12, height, channels: 3, background: '#e01818' } }, left: tileWidth * divider, top: 0 });
  const base = () => sharp({ create: { width, height, channels: 3, background: '#000' } });
  try {
    await base().composite(composite).jpeg({ quality: 88 }).toFile(path);
  } catch {
    // Text needs a font; without one the frames still show.
    await base().composite(composite.filter(item => !Buffer.isBuffer(item.input) || item.input.length > 2000)).jpeg({ quality: 88 }).toFile(path);
  }
}

/**
 * Write the join sheets, full-size frames either side of each cut and a sheet per shot. `at` (seconds) replaces cut
 * detection when the edit list is known; detected and given cuts are the first frame of the shot after the join.
 */
export async function joinsReport(video, { out, at = null, tileWidth = 480 } = {}) {
  mkdirSync(out, { recursive: true });
  const info = await probe(video);
  const fps = info.fps || 24;
  const count = info.frames;
  const cuts = at ? [...new Set(at.map(s => Math.round(s * fps)))].filter(f => f > 0 && f < count).sort((a, b) => a - b) : await findCuts(video);
  const joins = joinsOf(cuts);
  const tileHeight = Math.round(tileWidth * info.height / Math.max(1, info.width) / 2) * 2;
  const seconds = frame => (frame / fps).toFixed(2);
  const inRange = f => f >= 0 && f < count;

  // What each sheet needs, decoded in two passes (small tiles; full-size frames either side of each join).
  const rowFrames = join => [...Array.from({ length: SIDE }, (_, i) => join.from - SIDE + i), ...Array.from({ length: SIDE }, (_, i) => join.to + i)];
  const bounds = [0, ...joins.flatMap(j => [j.from, j.to + 1]), count];
  const spans = [];
  for (let k = 0; k + 1 < bounds.length; k += 2) if (bounds[k + 1] - 1 >= bounds[k]) spans.push([bounds[k], bounds[k + 1] - 1]);
  const shotPicks = spans.map(([a, b]) => {
    const n = Math.min(SHOT_FRAMES, b - a + 1);
    return Array.from({ length: n }, (_, i) => Math.round(a + i * (b - a) / Math.max(1, n - 1)));
  });
  const small = await framesAt(video, [...joins.flatMap(rowFrames), ...shotPicks.flat()].filter(inRange), tileWidth, tileHeight);
  const full = joins.length ? await framesAt(video, joins.flatMap(j => [j.from - 1, j.to]).filter(inRange)) : new Map();

  // Joins: 3 frames before | 3 after, one row per join (after = once any flash or dissolve has passed).
  const sheets = [];
  for (let page = 0; page * CUTS_PER_PAGE < joins.length; page++) {
    const rows = joins.slice(page * CUTS_PER_PAGE, (page + 1) * CUTS_PER_PAGE).map((j, r) => {
      const k = page * CUTS_PER_PAGE + r + 1;
      const through = j.to > j.from ? ` (transition f${j.from}-f${j.to})` : '';
      return rowFrames(j).map((frame, i) => {
        if (!inRange(frame)) return null;
        const side = i < SIDE ? `before ${SIDE - i}` : i === SIDE ? `AFTER 1${through}` : `after ${i - SIDE + 1}`;
        return { image: small.get(frame), text: `cut ${k} · ${side} · ${seconds(frame)} s · f${frame}` };
      });
    });
    const path = join(out, `joins-${page + 1}.jpg`);
    await sheet(path, rows, tileWidth, tileHeight, SIDE * 2, SIDE);
    sheets.push(path);
  }

  // Full-size frames either side of each join, to compare at native pixels.
  const frames = [];
  for (const [k, j] of joins.entries()) {
    for (const [side, frame] of [['before', j.from - 1], ['after', j.to]]) {
      if (!inRange(frame)) continue;
      const path = join(out, `cut-${String(k + 1).padStart(2, '0')}-${side}.jpg`);
      writeFileSync(path, full.get(frame));
      frames.push(path);
    }
  }

  // Every shot, densely: 12 frames over it, 6 across.
  const shots = [];
  for (const [k, picks] of shotPicks.entries()) {
    const rows = [];
    for (let i = 0; i < picks.length; i += 6) rows.push(picks.slice(i, i + 6).map(f => ({ image: small.get(f), text: `shot ${k + 1} · ${seconds(f)} s · f${f}` })));
    const path = join(out, `shot-${String(k + 1).padStart(2, '0')}.jpg`);
    await sheet(path, rows, tileWidth, tileHeight, 6);
    shots.push({ shot: k + 1, from: spans[k][0], to: spans[k][1], seconds: [+seconds(spans[k][0]), +seconds(spans[k][1])], sheet: path });
  }
  const report = { video, fps, frames: count, cuts: joins.map((j, k) => ({ cut: k + 1, frame: j.from, through: j.to, at: +seconds(j.from) })),
                   shots, sheets, fullFrames: frames };
  writeFileSync(join(out, 'joins.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

/** What to compare at every join: said once by the command, kept here so the docs and the tool agree. */
export const JOIN_CHECKS = [
  'Who is in the frame and on which side: the same people, on the same sides, as the shot before.',
  'Props and wardrobe: the same props in the same hands; nothing appears, vanishes or swaps (a phone put away stays away).',
  'Vehicles: the same model, colour, lights, mirrors on both doors, plate text, and the same passengers in the same seats.',
  'Eyelines and screen direction: a person looks at whoever they are talking to; motion keeps its direction across the cut.',
  'Geography: a character who is in one place in the shot before is still there, or a shot shows them moving.',
  'Background: what is behind the subject is really behind them from that angle; traffic keeps to its lanes.',
  'Light and time: the same light family, weather and time of day, unless the story jumps.',
  'Sound: no click, gap or doubled line at the join; a line that crosses the cut stays in sync.',
];
