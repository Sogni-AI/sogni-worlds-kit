// joins: inspect every cut in a stitched film, frame by frame on both sides.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';
import { joinsReport, JOIN_CHECKS } from '../lib/joins.js';

export const summary = 'Show every cut in a stitched film frame by frame on both sides, and every shot densely, for a continuity check';
export const usage = `node world joins <video.mp4> [--at <seconds,seconds,...>] [--out <folder>]

  For anything you cut together from several takes: a trailer, a preview loop, a
  multi-shot scene, a recut. Finds every hard cut (or uses --at, the edit list's
  cut times in seconds, when you have them) and writes, next to the video in
  <video>.joins/ unless --out says otherwise:
    joins-<n>.jpg        one row per cut: the 3 frames before | the 3 after
    cut-<k>-before.jpg   the last frame before cut k, full size
    cut-<k>-after.jpg    the first frame after cut k, full size
    shot-<k>.jpg         12 frames over every shot
    joins.json           the cuts and shots

  Open every joins sheet and every shot sheet, and compare the before and after
  frames of every cut at full size. A join that breaks continuity is a defect
  even when each shot is perfect on its own.`;

export async function run(argv) {
  const { values, positionals } = parse(argv, { at: { type: 'string' }, out: { type: 'string' } });
  const video = positionals[0] && resolve(positionals[0]);
  if (!video || !existsSync(video)) {
    console.error(`No video to inspect. Usage: ${usage.split('\n')[0]}`);
    return 1;
  }
  const at = values.at ? values.at.split(',').map(Number).filter(Number.isFinite) : null;
  const out = resolve(values.out ?? video.replace(/\.[^.]+$/, '') + '.joins');
  const report = await joinsReport(video, { out, at });
  console.log(`${report.cuts.length} cut${report.cuts.length === 1 ? '' : 's'}, ${report.shots.length} shot${report.shots.length === 1 ? '' : 's'} (${at ? 'from --at' : 'detected'}) -> ${out}`);
  for (const cut of report.cuts) console.log(`  cut ${cut.cut} at ${cut.at.toFixed(2)} s (frame ${cut.frame})`);
  console.log(`\nOpen ${report.sheets.length} joins sheet${report.sheets.length === 1 ? '' : 's'} and ${report.shots.length} shot sheet${report.shots.length === 1 ? '' : 's'}; at every cut, check:`);
  for (const check of JOIN_CHECKS) console.log(`  - ${check}`);
  if (!at) console.log('\nDetection misses soft cuts (two similar shots, or a cut under fast motion). Have the edit list? Pass its cut times with --at.');
  return 0;
}
