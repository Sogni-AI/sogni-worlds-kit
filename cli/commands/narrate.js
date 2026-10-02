// narrate: each place's lines, spoken, with a time for every subtitle.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId, shown, worldFile } from '../lib/paths.js';
import { readJson, writeJson, sha256, sha256File } from '../lib/files.js';
import { probe } from '../lib/media.js';
import { connect, describeBilling } from '../lib/sogni.js';
import { levelAudio } from '../lib/finish.js';
import { loudness } from '../lib/screen.js';
import { SPEECH_MODELS, STUDIO_VOICES, SPEECH_LIMITS, renderAudio, samples, pauses, ending, lineTimes, writeBytes } from '../lib/audio.js';

export const NARRATION_LUFS = -16;

export const summary = 'Speak each place\'s narration (Qwen3-TTS: your cloned voice, a designed voice or a studio voice)';
export const usage = `node world narrate [world] [--only <place> ...] [--retake <place> ...]

  For every place with narration lines: renders all its lines as one take in
  the place's voice (world.yaml voices:), checks the ending is not clipped,
  times every line from the pauses, levels it to ${NARRATION_LUFS} LUFS and saves
  audio/narration/<place>.mp3 with its receipt. Places already spoken are
  skipped; --retake renders a place again (the old take is kept beside it).

  Voices in world.yaml:
    narrator: { clone: voices/me.m4a, transcript: "exactly what the recording says" }
    guide:    { design: "a warm, unhurried woman in her forties, close to the microphone" }
    host:     { studio: serena, style: "cheerful, a little breathless" }
  Clone only a voice you own or have permission to use.

  A designed voice is designed ONCE: the first run speaks a short fixed passage
  from the description and keeps it as voices/<name>.designed.wav, and every
  place is then cloned from that sample, so the voice is the same person in
  every place. (Designing per place invents a new voice each time.) Listen to
  the sample first; change the description to design a new one.`;

/**
 * What a designed voice speaks once, to become the sample every line is
 * cloned from: about 15 seconds of plain, varied narration.
 */
export const ANCHOR_SCRIPT = 'Hello, and welcome. I will be your guide today. We will take our time, stop wherever something catches the eye, and I will tell you what happened there. Some of it is funny, some of it is quiet, and all of it is true.';

/** voices/<name>.designed.{wav,json}: the one sample a designed voice is cloned from. */
export const anchorFiles = (paths, name) => ({ wav: join(paths.voices, `${name}.designed.wav`), json: join(paths.voices, `${name}.designed.json`) });

/** The anchor sample for a designed voice, if it exists and matches the description. */
export function designedAnchor(paths, name, voice) {
  const files = anchorFiles(paths, name);
  if (!existsSync(files.wav) || !existsSync(files.json)) return null;
  const meta = readJson(files.json);
  if (meta.design !== String(voice.design) || meta.script !== ANCHOR_SCRIPT) return null;
  return { file: files.wav, transcript: meta.script };
}

/** Speak the anchor sample for a designed voice once. Every place is cloned from it. */
export async function makeAnchor({ session, paths, name, voice, language }) {
  const files = anchorFiles(paths, name);
  mkdirSync(paths.voices, { recursive: true });
  const journalPath = join(paths.voices, `${name}.designed.receipt.json`);
  if (existsSync(journalPath) && readJson(journalPath).design !== String(voice.design)) renameSync(journalPath, `${journalPath}.${Date.now()}.old`);
  log.step(`Designing the voice "${name}" once: ${String(voice.design).slice(0, 80)}${String(voice.design).length > 80 ? '…' : ''}`);
  const request = { positivePrompt: ANCHOR_SCRIPT, language, outputFormat: 'wav', modelId: SPEECH_MODELS.design, instruct: String(voice.design) };
  const { bytes } = await renderAudio({ session, journalPath, request, record: { voice: name, design: String(voice.design), anchor: true }, contentType: 'audio/wav', say: text => log.dim(text) });
  writeBytes(files.wav, bytes);
  const seconds = (await probe(files.wav)).seconds;
  const [min, max] = SPEECH_LIMITS.referenceSeconds;
  if (!(seconds >= min && seconds <= max)) throw new Error(`the designed sample is ${seconds.toFixed(1)} s; cloning needs ${min}–${max} s. Run narrate again to design it again`);
  writeJson(files.json, { design: String(voice.design), script: ANCHOR_SCRIPT, sha256: sha256File(files.wav), seconds: +seconds.toFixed(2), madeAt: new Date().toISOString() });
  log.ok(`The voice "${name}" → ${shown(files.wav)} (${seconds.toFixed(1)} s). Every place is cloned from it; listen to it first.`);
}

export async function run(argv) {
  const { values, world } = parse(argv, { only: { type: 'string', multiple: true }, retake: { type: 'string', multiple: true } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const dir = join(paths.audio, 'narration');
  mkdirSync(dir, { recursive: true });
  const wanted = new Set([...(values.only ?? []), ...(values.retake ?? [])]);
  const places = plan.places.filter(p => (p.narration?.lines ?? []).length && (!wanted.size || wanted.has(p.id)));
  for (const name of wanted) if (!places.some(p => p.id === name)) throw new Error(`"${name}" is not a place with narration lines`);

  const todo = [];
  for (const place of places) {
    const journalPath = join(dir, `${place.id}.json`);
    if (values.retake?.includes(place.id) && existsSync(journalPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const ext of ['json', 'raw.wav', 'mp3']) {
        const file = join(dir, `${place.id}.${ext}`);
        if (existsSync(file)) renameSync(file, join(dir, `${place.id}.${stamp}.${ext === 'json' ? 'json.old' : ext}`));
      }
    }
    const journal = existsSync(journalPath) ? readJson(journalPath) : null;
    if (journal?.status === 'completed' && journal.mp3) continue;
    todo.push(place);
  }
  if (!todo.length) {
    log.ok('Every place with narration is already spoken.');
    log.next(nextStep(id));
    return 0;
  }
  const session = await connect();
  let failures = 0;
  try {
    log.info(`Signed in as ${session.username} · ${describeBilling(session.billing)}`);
    // A designed voice is designed once, then cloned in every place: the same narrator throughout.
    const designed = [...new Set(todo.map(p => p.narration.voice).filter(name => plan.voices?.[name]?.design))];
    for (const name of designed) {
      const voice = plan.voices[name];
      if (!designedAnchor(paths, name, voice)) await makeAnchor({ session, paths, name, voice, language: voice.language ?? plan.language ?? 'auto' });
    }
    for (const place of todo) voiceRequest(plan, paths, place); // check every voice before paying for any
    for (const place of todo) {
      try {
        await narratePlace({ session, plan, paths, place, dir });
      } catch (error) {
        failures++;
        log.fail(`${place.id}: ${error.message}`);
      }
    }
  } finally {
    session.close();
  }
  if (failures) return 1;
  log.info('Listen to each one before you build: the voice, the words, the ending.');
  log.next(nextStep(id));
  return 0;
}

/** What to send for this place's voice. Throws if the voice is not usable. */
export function voiceRequest(plan, paths, place) {
  const name = place.narration.voice;
  const voice = name ? plan.voices?.[name] : null;
  if (name && !voice) throw new Error(`${place.id}: voice "${name}" is not in voices:`);
  const lines = place.narration.lines.map(String);
  const script = lines.join(' ');
  if (script.length > SPEECH_LIMITS.script) throw new Error(`${place.id}: ${script.length} characters; one take holds ${SPEECH_LIMITS.script}`);
  const language = voice?.language ?? plan.language ?? 'auto';
  const base = { positivePrompt: script, language, outputFormat: 'wav' };
  if (!voice || voice.studio) {
    const speaker = voice?.studio ?? 'serena';
    if (!STUDIO_VOICES.includes(speaker)) throw new Error(`${place.id}: studio voice "${speaker}" is not one of ${STUDIO_VOICES.join(', ')}`);
    return { mode: 'studio', lines, request: { ...base, modelId: SPEECH_MODELS.studio, speaker, ...(voice?.style ? { instruct: String(voice.style).slice(0, SPEECH_LIMITS.instruct) } : {}) } };
  }
  if (voice.design) {
    if (String(voice.design).length > SPEECH_LIMITS.instruct) throw new Error(`${place.id}: the voice description is limited to ${SPEECH_LIMITS.instruct} characters`);
    const anchor = designedAnchor(paths, name, voice);
    if (!anchor) throw new Error(`${place.id}: the voice "${name}" has no designed sample yet (narrate makes it first)`);
    return { mode: 'designed', lines, reference: anchor.file, request: { ...base, modelId: SPEECH_MODELS.clone, referenceText: anchor.transcript } };
  }
  if (voice.clone) {
    const file = worldFile(paths, voice.clone, `voices.${name}.clone`);
    if (!existsSync(file)) throw new Error(`${place.id}: the recording ${voice.clone} is missing (put it in ${shown(paths.voices)}/)`);
    if (!voice.transcript) throw new Error(`${place.id}: voice "${name}" needs the transcript of its recording (what it says, word for word)`);
    if (String(voice.transcript).length > SPEECH_LIMITS.transcript) throw new Error(`${place.id}: the transcript is limited to ${SPEECH_LIMITS.transcript} characters`);
    return { mode: 'clone', lines, reference: file, request: { ...base, modelId: SPEECH_MODELS.clone, referenceText: String(voice.transcript) } };
  }
  throw new Error(`${place.id}: voice "${name}" needs clone + transcript, design, or studio`);
}

export async function narratePlace({ session, plan, paths, place, dir }) {
  const journalPath = join(dir, `${place.id}.json`);
  const { mode, lines, reference, request } = voiceRequest(plan, paths, place);
  let referenceSha256 = null;
  if (reference) {
    const seconds = (await probe(reference)).seconds;
    const [min, max] = SPEECH_LIMITS.referenceSeconds;
    if (!(seconds >= min && seconds <= max)) throw new Error(`the recording is ${seconds.toFixed(1)} s; cloning takes ${min}–${max} s of clean speech`);
    const bytes = readFileSync(reference);
    request.referenceAudio = bytes;
    referenceSha256 = sha256(bytes);
  }
  const quote = await speechQuote(session, request).catch(() => null);
  log.step(`${place.id}: ${mode} voice, ${request.positivePrompt.length} characters${quote ? ` · about ${quote}` : ''}`);
  const record = { place: place.id, voice: place.narration.voice ?? null, mode, text: request.positivePrompt, lines,
    language: request.language, ...(referenceSha256 ? { reference: shown(reference), referenceSha256 } : {}),
    account: session.username };
  const { journal, bytes } = await renderAudio({ session, journalPath, request, record, contentType: 'audio/wav', say: text => log.dim(text) });

  const raw = join(dir, `${place.id}.raw.wav`);
  writeBytes(raw, bytes);
  const pcm = await samples(raw);
  const seconds = pcm.length / 24000;
  const end = ending(pcm);
  const timing = lineTimes(lines, pauses(pcm), seconds);
  const speaker = place.narration.speaker ?? plan.voices?.[place.narration.voice]?.label;
  const mp3 = join(dir, `${place.id}.mp3`);
  await levelAudio(raw, mp3, { lufs: NARRATION_LUFS, truePeak: -1.5, bitrate: '96k', mono: true, sampleRate: 24000 });
  const heard = await loudness(mp3);
  writeJson(journalPath, {
    ...journal,
    mp3: `${place.id}.mp3`,
    sha256: sha256File(mp3),
    seconds: +seconds.toFixed(3),
    split: timing.split,
    lines: timing.lines.map(line => (speaker ? { ...line, speaker } : line)),
    ending: end,
    loudness: heard,
  });
  log.ok(`${place.id}: ${seconds.toFixed(1)} s, ${lines.length} line(s) timed by ${timing.split}, ${heard.lufs} LUFS → ${shown(mp3)}`);
  if (!end.clean) log.warn(`${place.id}: the ending may be clipped (${end.tailMs} ms of silence after the last sound). Listen; re-take with: node world narrate --retake ${place.id}`);
  if (timing.split === 'length') log.warn(`${place.id}: the pauses do not fall between the lines, so the subtitles are timed by length. Listen, or re-take.`);
}

/**
 * What one place's narration take costs: { usd, token }. Speech bills by
 * characters; the SDK's estimate does not take them yet, so ask the endpoint directly.
 */
export async function speechEstimate(session, request) {
  const { client, billing } = session;
  const segments = [billing.tokenType, request.modelId, 30, 1, 1].map(encodeURIComponent).join('/');
  const response = await client.apiClient.socket.get(`/api/v1/job-audio/estimate/${segments}`, { characters: Math.max(1, request.positivePrompt.length) });
  const quote = response.quote.project;
  return { usd: Number(quote.costInUSD), token: Number(quote.costInToken) };
}

async function speechQuote(session, request) {
  const { usd, token } = await speechEstimate(session, request);
  return session.billing.mode === 'subscription' ? `$${usd.toFixed(3)} of plan value` : `$${usd.toFixed(3)} (${token.toFixed(2)} ${session.billing.tokenType})`;
}
