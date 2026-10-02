// figures: stand every collectible up in 3D (BiRefNet cut-out, Pixal3D mesh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId, shown, filmId } from '../lib/paths.js';
import { readJson, writeJson, sha256 } from '../lib/files.js';
import { connect } from '../lib/sogni.js';
import { cutoutOf, figureFiles, FIGURE_MODELS, FIGURE_QUALITY, headNoun, matteJob, meshJob, regionOf } from '../lib/figures.js';
import { nextStep } from './status.js';

export const summary = 'Stand every collectible up in 3D (Pixal3D), so a visitor can pick it up and turn it over';
export const usage = `node world figures [world] [--only <place-object> ...] [--cutouts] [--force]

  Every object marked collect: true (and any with figure: true) becomes a
  figure the visitor turns over in 3D when they find it. The object is cut out
  of its own picture: its SAM 3 outline says where it is, BiRefNet draws its
  real edge, and Pixal3D reconstructs it as a GLB of about 60,000 triangles
  with a 2K texture (8–12 MB). Run select first. figure: false on an object
  keeps it a plain collectible.

  --cutouts stops after the cut-outs (figures/<place>-<object>.png) so you can
  look at them first; the next run builds the meshes from those same cut-outs.

  Writes figures/<place>-<object>.{png,glb,json}. A finished figure is never
  made again unless you pass --force. Look at every one in the player before
  you share the world: turn it over, check the back and the face.`;

export const wantsFigure = object => object.figure === true || (object.collect === true && object.figure !== false);

export async function run(argv) {
  const { values, world } = parse(argv, { only: { type: 'string', multiple: true }, cutouts: { type: 'boolean', default: false }, force: { type: 'boolean', default: false } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const only = values.only?.length ? new Set(values.only) : null;
  const todo = [];
  for (const place of plan.places) for (const object of place.objects ?? []) {
    const key = filmId(place.id, object.id);
    if (!wantsFigure(object) || (only && !only.has(key))) continue;
    const files = figureFiles(paths, key);
    const done = readJson(files.receipt, null)?.status;
    if (!values.force && ((done === 'completed' && existsSync(files.glb)) || (values.cutouts && done === 'cut'))) continue;
    const mask = join(paths.selections, `${key}.png`);
    if (!existsSync(mask)) { log.warn(`${key}: no outline yet; run node world select ${id} --only ${key}`); continue; }
    todo.push({ place, object, key, files, mask });
  }
  if (only) for (const key of only) if (!todo.some(t => t.key === key)) log.warn(`${key}: not a collectible, already made, or not outlined`);
  if (!todo.length) { log.ok('Every figure is made.'); log.next(nextStep(id)); return 0; }

  const session = await connect({ appId: `sogni-worlds-figures-${id}` });
  let made = 0;
  const failed = [];
  try {
    log.title(`Making ${todo.length} figure${todo.length === 1 ? '' : 's'} (${FIGURE_MODELS.mesh}, ${FIGURE_QUALITY.meshTargetFaces.toLocaleString()} triangles)`);
    for (const { place, object, key, files, mask } of todo) {
      mkdirSync(files.dir, { recursive: true });
      const previous = readJson(files.receipt, null);
      if (previous?.status === 'submitting' && !values.force) {
        failed.push(`${key}: a job was being submitted when the last run stopped; check your Sogni history, then run with --force`);
        continue;
      }
      // The lossless original when there is one: the cut-out is the figure's texture.
      const photo = place.photo && existsSync(join(paths.dir, place.photo)) ? join(paths.dir, place.photo) : null;
      const source = photo ?? join(paths.dir, place.still);
      const noun = object.figureNoun ?? headNoun(object.target || object.label);
      const receipt = { key, place: place.id, object: object.id, label: object.label, noun, source: shown(source), sourceSha256: sha256(readFileSync(source)), maskSha256: sha256(readFileSync(mask)), quality: FIGURE_QUALITY, models: FIGURE_MODELS };
      let cut = null;
      try {
        // A cut-out already made from these same inputs (--cutouts, or a mesh that failed) is reused.
        const reuse = !values.force && ['cut', 'failed'].includes(previous?.status) && previous.cutoutSha256 && existsSync(files.cutout)
          && previous.sourceSha256 === receipt.sourceSha256 && previous.maskSha256 === receipt.maskSha256 && sha256(readFileSync(files.cutout)) === previous.cutoutSha256;
        if (reuse) cut = { crop: previous.crop, matteProject: previous.matteProject, cutoutSha256: previous.cutoutSha256, png: readFileSync(files.cutout) };
        else {
          log.step(`${key}: cutting out "${noun}"`);
          const region = await regionOf({ source, mask });
          writeFileSync(files.region, region.png);
          writeJson(files.receipt, { ...receipt, crop: region.crop, status: 'submitting', stage: 'matte', at: new Date().toISOString() });
          const matte = await matteJob(session, region.png);
          writeFileSync(files.matte, matte.png);
          const cutout = await cutoutOf(region.png, matte.png, region.outline);
          writeFileSync(files.cutout, cutout.png);
          cut = { crop: region.crop, scale: region.scale, matteProject: matte.projectId, cutoutSha256: sha256(cutout.png), png: cutout.png };
          writeJson(files.receipt, { ...receipt, ...cut, png: undefined, status: 'cut', at: new Date().toISOString() });
        }
        if (values.cutouts) { log.ok(`${key}: cut out — look at ${shown(files.cutout)}`); made++; continue; }
        writeJson(files.receipt, { ...receipt, ...cut, png: undefined, status: 'submitting', stage: 'mesh', at: new Date().toISOString() });
        const cutout = cut;
        log.step(`${key}: building the 3D model`);
        const started = Date.now();
        const mesh = await meshJob(session, cutout.png, noun);
        writeFileSync(files.glb, mesh.bytes);
        writeJson(files.receipt, { ...receipt, ...cut, png: undefined, meshProject: mesh.projectId, glb: mesh.glb,
          glbSha256: sha256(mesh.bytes), seconds: Math.round((Date.now() - started) / 1000), status: 'completed', at: new Date().toISOString() });
        log.ok(`${key}: ${(mesh.bytes.length / 1e6).toFixed(1)} MB, ${mesh.glb.triangles.toLocaleString()} triangles, ${mesh.glb.textures} texture(s) — ${shown(files.glb)}`);
        made++;
      } catch (error) {
        writeJson(files.receipt, { ...receipt, ...(cut ?? {}), png: undefined, status: 'failed', error: String(error.message).slice(0, 300), at: new Date().toISOString() });
        failed.push(`${key}: ${error.message}`);
        log.fail(`${key}: ${error.message}`);
      }
    }
  } finally {
    session.close();
  }
  log.title(`${made} figure${made === 1 ? '' : 's'} made${failed.length ? `, ${failed.length} not` : ''}`);
  for (const line of failed) log.warn(line);
  log.info('Turn each one over in the player (node world play) before you share the world: the back and any face are where a figure goes wrong.');
  log.next(nextStep(id));
  return failed.length ? 1 : 0;
}
