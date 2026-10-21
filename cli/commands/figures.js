// figures: stand every collectible up in 3D (BiRefNet cut-out, Pixal3D mesh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId, shown, filmId } from '../lib/paths.js';
import { readJson, writeJson, sha256 } from '../lib/files.js';
import { connect } from '../lib/sogni.js';
import { cutoutOf, figureFiles, FIGURE_MODELS, FIGURE_QUALITY, headNoun, matteJob, meshJob, plateContext, plateJob, platePrompt } from '../lib/figures.js';
import { contentFilterOff } from './render.js';
import { nextStep } from './status.js';

export const summary = 'Stand every collectible up in 3D (Pixal3D), so a visitor can pick it up and turn it over';
export const usage = `node world figures [world] [--only <place-object> ...] [--cutouts] [--force]

  Every object marked collect: true (and any with figure: true) becomes a
  figure the visitor turns over in 3D when they find it. A thing in a picture
  is small, lies on something and shows one side, so it is made again first:
  Qwen Image Edit draws it alone, whole and detailed on a white plate from a
  crop of its picture (its SAM 3 outline only says where it is) and from its
  close look when it has one, in the words of figureLook (what it is, with any
  writing on it named as what it reads). Pixal3D builds the GLB from that
  plate (about 60,000 triangles, a 2K texture, 8–12 MB); BiRefNet cuts the
  plate out for the collection's icon. Run select first. figure: false on an
  object keeps it a plain collectible.

  --cutouts stops after the plates (figures/<place>-<object>.plate.png, beside
  the crop it was drawn from, .context.png) so you can look at them first: the
  whole object, every side it shows detailed, nothing else on the plate (no
  table, hand or stand), its colours and markings as in the picture. The next
  run builds the meshes from those same plates.

  Writes figures/<place>-<object>.{context.png,plate.png,png,glb,json}. A
  finished figure is never made again unless you pass --force. Turn every one
  over in the player before you share the world: the back, the underside and
  any face are where a figure goes wrong.`;

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
      // The lossless original when there is one: the crop is what the plate is drawn from.
      const photo = place.photo && existsSync(join(paths.dir, place.photo)) ? join(paths.dir, place.photo) : null;
      const source = photo ?? join(paths.dir, place.still);
      const closeLook = !object.goes && object.reveal?.still && existsSync(join(paths.dir, object.reveal.still)) ? join(paths.dir, object.reveal.still) : null;
      const noun = object.figureNoun ?? headNoun(object.target || object.label);
      const prompt = platePrompt(object.figureLook ?? object.target ?? object.figureName ?? noun, { closeLook: Boolean(closeLook) });
      const receipt = { key, place: place.id, object: object.id, label: object.label, noun, source: shown(source), sourceSha256: sha256(readFileSync(source)), maskSha256: sha256(readFileSync(mask)),
        ...(closeLook ? { closeLook: shown(closeLook), closeLookSha256: sha256(readFileSync(closeLook)) } : {}), prompt, quality: FIGURE_QUALITY, models: FIGURE_MODELS };
      let cut = null;
      try {
        // A plate already made from these same inputs (--cutouts, or a mesh that failed) is reused.
        const reuse = !values.force && ['cut', 'failed'].includes(previous?.status) && previous.plateSha256 && existsSync(files.plate)
          && ['sourceSha256', 'maskSha256', 'closeLookSha256', 'prompt'].every(field => previous[field] === receipt[field]) && sha256(readFileSync(files.plate)) === previous.plateSha256;
        if (reuse) cut = { crop: previous.crop, plateProject: previous.plateProject, matteProject: previous.matteProject, plateSha256: previous.plateSha256, cutoutSha256: previous.cutoutSha256, plate: readFileSync(files.plate) };
        else {
          log.step(`${key}: drawing "${noun}" alone on a plate`);
          const context = await plateContext({ source, mask });
          writeFileSync(files.context, context.png);
          writeJson(files.receipt, { ...receipt, crop: context.crop, status: 'submitting', stage: 'plate', at: new Date().toISOString() });
          const plate = await plateJob(session, { contexts: [...(closeLook ? [readFileSync(closeLook)] : []), context.png], prompt, contentFilter: !contentFilterOff(plan) });
          writeFileSync(files.plate, plate.png);
          writeJson(files.receipt, { ...receipt, crop: context.crop, plateProject: plate.projectId, status: 'submitting', stage: 'matte', at: new Date().toISOString() });
          const matte = await matteJob(session, plate.png);
          writeFileSync(files.matte, matte.png);
          const cutout = await cutoutOf(plate.png, matte.png);
          writeFileSync(files.cutout, cutout.png);
          cut = { crop: context.crop, plateProject: plate.projectId, matteProject: matte.projectId, plateSha256: sha256(plate.png), cutoutSha256: sha256(cutout.png), plate: plate.png };
          writeJson(files.receipt, { ...receipt, ...cut, plate: undefined, status: 'cut', at: new Date().toISOString() });
        }
        if (values.cutouts) { log.ok(`${key}: plate made — look at ${shown(files.plate)} beside ${shown(files.context)}`); made++; continue; }
        writeJson(files.receipt, { ...receipt, ...cut, plate: undefined, status: 'submitting', stage: 'mesh', at: new Date().toISOString() });
        log.step(`${key}: building the 3D model`);
        const started = Date.now();
        const mesh = await meshJob(session, cut.plate, noun);
        writeFileSync(files.glb, mesh.bytes);
        writeJson(files.receipt, { ...receipt, ...cut, plate: undefined, meshProject: mesh.projectId, glb: mesh.glb,
          glbSha256: sha256(mesh.bytes), seconds: Math.round((Date.now() - started) / 1000), status: 'completed', at: new Date().toISOString() });
        log.ok(`${key}: ${(mesh.bytes.length / 1e6).toFixed(1)} MB, ${mesh.glb.triangles.toLocaleString()} triangles, ${mesh.glb.textures} texture(s) — ${shown(files.glb)}`);
        made++;
      } catch (error) {
        writeJson(files.receipt, { ...receipt, ...(cut ?? {}), plate: undefined, status: 'failed', error: String(error.message).slice(0, 300), at: new Date().toISOString() });
        failed.push(`${key}: ${error.message}`);
        log.fail(`${key}: ${error.message}`);
      }
    }
  } finally {
    session.close();
  }
  log.title(`${made} figure${made === 1 ? '' : 's'} made${failed.length ? `, ${failed.length} not` : ''}`);
  for (const line of failed) log.warn(line);
  log.info('Turn each one over in the player (node world play) before you share the world: the back, the underside and any face are where a figure goes wrong.');
  log.next(nextStep(id));
  return failed.length ? 1 : 0;
}
