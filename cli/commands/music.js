// music: the score under the whole world — generated, or yours.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId, shown, worldFile } from '../lib/paths.js';
import { readJson, writeJson, sha256File } from '../lib/files.js';
import { connect, describeBilling } from '../lib/sogni.js';
import { levelAudio } from '../lib/finish.js';
import { loudness } from '../lib/screen.js';
import { probe } from '../lib/media.js';
import { INSTRUMENTAL_SECTIONS, MUSIC_MODELS, musicModel, renderAudio, writeBytes } from '../lib/audio.js';

export const MUSIC_LUFS = -18;

export const summary = 'Make the world\'s music (MiniMax Music 3 on Sogni) or level a track you own';
export const usage = `node world music [world] [--retake]

  world.yaml music: either
    prompt: "gentle fingerpicked acoustic guitar and soft strings, 84 BPM, D major, warm, unhurried"
    seconds: 120            # 10–300 (a ceiling: Music 3 may end on a resolution a little sooner)
    model: minimax_music3   # the default; ace_step_1.5_xl_turbo or _sft for exact bpm/keyscale and up to 600 s
  or, only for music you have the rights to:
    file: music/my-song.mp3
    credit: "Song — Artist"
  Generated music is instrumental (no lyrics are sent). Either way the track is
  levelled to about ${MUSIC_LUFS} LUFS so it sits under the films' sound, and saved
  as audio/music/music.mp3 with its receipt. --retake makes a new one.`;

/** The model and length a generated score uses. Throws if the plan's music is not usable. */
export function musicJob(music) {
  if (!music.prompt) throw new Error('music: needs prompt (to generate) or file (music you own)');
  const model = musicModel(music.model);
  if (!model) throw new Error(`Unknown music model "${music.model}"; use ${Object.values(MUSIC_MODELS).map(m => m.id).join(', ')}`);
  const [min, max] = model.seconds;
  const seconds = Math.min(max, Math.max(min, Math.round(Number(music.seconds ?? 120))));
  return { model, seconds };
}

/**
 * The request for a generated score. Music 3 takes tempo, key and metre in
 * the prompt and a section skeleton for an instrumental; ACE-Step takes them
 * as controls and plays instrumental when no lyrics are sent.
 */
export function musicRequest(music) {
  const { model, seconds } = musicJob(music);
  const common = { modelId: model.id, duration: seconds, steps: model.steps, outputFormat: 'mp3', ...(Number.isInteger(music.seed) ? { seed: music.seed } : {}) };
  if (model.tempoInPrompt) {
    const extra = [music.bpm ? `${Number(music.bpm)} BPM` : null, music.keyscale ? String(music.keyscale) : null, music.timesignature ? `${music.timesignature}/4 time` : null].filter(Boolean);
    return { ...common, positivePrompt: [String(music.prompt).trim(), ...extra].join(', '), lyrics: INSTRUMENTAL_SECTIONS,
      guidance: model.guidance, sampler: model.sampler, scheduler: model.scheduler };
  }
  return { ...common, positivePrompt: String(music.prompt), shift: model.shift,
    ...(model.guidance ? { guidance: model.guidance } : {}),
    ...(music.bpm ? { bpm: Number(music.bpm) } : {}),
    ...(music.keyscale ? { keyscale: String(music.keyscale) } : {}),
    ...(music.timesignature ? { timesignature: String(music.timesignature) } : {}) };
}

/** What generating the score would cost, from Sogni's own estimate: { usd, token, seconds, model }. */
export async function musicEstimate(session, music) {
  const { model, seconds } = musicJob(music);
  const quote = await session.client.projects.estimateAudioCost({ tokenType: session.billing.tokenType, model: model.id, duration: seconds, steps: model.steps,
    numberOfMedia: 1, network: 'fast', ...(session.billing.mode !== 'auto' ? { billingMode: session.billing.mode } : {}) });
  return { usd: Number(quote.usd), token: Number(quote[session.billing.tokenType]), seconds, model: model.id };
}

export async function run(argv) {
  const { values, world } = parse(argv, { retake: { type: 'boolean', default: false } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const music = plan.music;
  if (!music) {
    log.ok('This world has no music (music: in world.yaml).');
    log.next(nextStep(id));
    return 0;
  }
  const dir = join(paths.audio, 'music');
  mkdirSync(dir, { recursive: true });
  const journalPath = join(dir, 'music.json');
  if (values.retake && existsSync(journalPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const name of ['music.json', 'music.raw.mp3', 'music.mp3']) {
      if (existsSync(join(dir, name))) renameSync(join(dir, name), join(dir, `${stamp}.${name}${name.endsWith('.json') ? '.old' : ''}`));
    }
  }
  const existing = existsSync(journalPath) ? readJson(journalPath) : null;
  if (existing?.status === 'completed' && existing.mp3 && existsSync(join(dir, existing.mp3))) {
    log.ok(`The music is made: ${shown(join(dir, existing.mp3))}`);
    log.next(nextStep(id));
    return 0;
  }

  if (music.file) {
    const source = worldFile(paths, music.file, 'music.file');
    if (!existsSync(source)) throw new Error(`${music.file} is missing`);
    const out = join(dir, 'music.mp3');
    await levelAudio(source, out, { lufs: MUSIC_LUFS, truePeak: -1.5, bitrate: '192k' });
    const heard = await loudness(out);
    writeJson(journalPath, { status: 'completed', source: 'file', file: music.file, sourceSha256: sha256File(source), credit: music.credit ?? null,
      mp3: 'music.mp3', sha256: sha256File(out), seconds: +(await probe(out)).seconds.toFixed(2), loudness: heard, completedAt: new Date().toISOString() });
    log.ok(`Levelled ${music.file} to ${heard.lufs} LUFS → ${shown(out)}`);
    if (!music.credit) log.warn('Add credit: to music: in world.yaml so the player can name the track.');
    log.next(nextStep(id));
    return 0;
  }

  const { model, seconds } = musicJob(music);
  const request = musicRequest(music);
  const session = await connect();
  try {
    log.info(`Signed in as ${session.username} · ${describeBilling(session.billing)}`);
    const quote = await musicEstimate(session, music).catch(() => null);
    log.step(`Composing ${seconds} s with ${model.id}${quote ? ` · about $${Number(quote.usd).toFixed(3)}${session.billing.mode === 'subscription' ? ' of plan value' : ''}` : ''}`);
    const { journal, bytes } = await renderAudio({ session, journalPath, request, contentType: 'audio/mpeg',
      record: { prompt: music.prompt, seconds, credit: music.credit ?? 'Music made with Sogni', account: session.username }, say: text => log.dim(text) });
    const raw = join(dir, 'music.raw.mp3');
    writeBytes(raw, bytes);
    const out = join(dir, 'music.mp3');
    await levelAudio(raw, out, { lufs: MUSIC_LUFS, truePeak: -1.5, bitrate: '192k' });
    const heard = await loudness(out);
    writeJson(journalPath, { ...journal, source: 'generated', credit: journal.credit, mp3: 'music.mp3', sha256: sha256File(out),
      seconds: +(await probe(out)).seconds.toFixed(2), loudness: heard });
    log.ok(`${seconds} s of music at ${heard.lufs} LUFS → ${shown(out)}`);
    log.info('Listen to it all the way through, including where it loops back to the start.');
  } finally {
    session.close();
  }
  log.next(nextStep(id));
  return 0;
}
