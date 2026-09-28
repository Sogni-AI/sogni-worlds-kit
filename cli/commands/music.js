// music: the score under the whole world — generated, or yours.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { readJson, writeJson, sha256File } from '../lib/files.js';
import { connect, describeBilling } from '../lib/sogni.js';
import { levelAudio } from '../lib/finish.js';
import { loudness } from '../lib/screen.js';
import { probe } from '../lib/media.js';
import { musicModel, renderAudio, writeBytes } from '../lib/audio.js';

export const MUSIC_LUFS = -18;

export const summary = 'Make the world\'s music (ACE-Step on Sogni) or level a track you own';
export const usage = `node world music [world] [--retake]

  world.yaml music: either
    prompt: "gentle fingerpicked acoustic guitar and soft strings, warm, unhurried, loops cleanly"
    seconds: 120            # 10–600
    bpm: 84                 # optional; also keyscale: "D major", timesignature: 4
  or, only for music you have the rights to:
    file: music/my-song.mp3
    credit: "Song — Artist"
  Generated music is instrumental (no lyrics are sent). Either way the track is
  levelled to about ${MUSIC_LUFS} LUFS so it sits under the films' sound, and saved
  as audio/music/music.mp3 with its receipt. --retake makes a new one.`;

export async function run(argv) {
  const { values, world } = parse(argv, { retake: { type: 'boolean', default: false } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const music = plan.music;
  if (!music) {
    log.ok('This world has no music (music: in world.yaml).');
    log.next('node world build');
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
    log.next('node world build');
    return 0;
  }

  if (music.file) {
    const source = join(paths.dir, music.file);
    if (!existsSync(source)) throw new Error(`${music.file} is missing`);
    const out = join(dir, 'music.mp3');
    await levelAudio(source, out, { lufs: MUSIC_LUFS, truePeak: -1.5, bitrate: '192k' });
    const heard = await loudness(out);
    writeJson(journalPath, { status: 'completed', source: 'file', file: music.file, sourceSha256: sha256File(source), credit: music.credit ?? null,
      mp3: 'music.mp3', sha256: sha256File(out), seconds: +(await probe(out)).seconds.toFixed(2), loudness: heard, completedAt: new Date().toISOString() });
    log.ok(`Levelled ${music.file} to ${heard.lufs} LUFS → ${shown(out)}`);
    if (!music.credit) log.warn('Add credit: to music: in world.yaml so the player can name the track.');
    log.next('node world build');
    return 0;
  }

  if (!music.prompt) throw new Error('music: needs prompt (to generate) or file (music you own)');
  const model = musicModel(music.model);
  if (!model) throw new Error(`Unknown music model "${music.model}"; use ace_step_1.5_xl_turbo or ace_step_1.5_xl_sft`);
  const seconds = Math.min(600, Math.max(10, Math.round(Number(music.seconds ?? 120))));
  const request = {
    modelId: model.id, positivePrompt: String(music.prompt), duration: seconds, steps: model.steps, shift: model.shift,
    ...(model.guidance ? { guidance: model.guidance } : {}),
    ...(music.bpm ? { bpm: Number(music.bpm) } : {}),
    ...(music.keyscale ? { keyscale: String(music.keyscale) } : {}),
    ...(music.timesignature ? { timesignature: String(music.timesignature) } : {}),
    ...(Number.isInteger(music.seed) ? { seed: music.seed } : {}),
    outputFormat: 'mp3',
  };
  const session = await connect();
  try {
    log.info(`Signed in as ${session.username} · ${describeBilling(session.billing)}`);
    const quote = await session.client.projects.estimateAudioCost({ tokenType: session.billing.tokenType, model: model.id, duration: seconds, steps: model.steps,
      numberOfMedia: 1, network: 'fast', ...(session.billing.mode !== 'auto' ? { billingMode: session.billing.mode } : {}) }).catch(() => null);
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
  log.next('node world build');
  return 0;
}
