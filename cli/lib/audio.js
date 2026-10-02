// Speech and music on Sogni, with the same discipline as films: the receipt is
// written before anything is paid for, an uncertain job is never submitted
// twice, and what comes back is measured before anyone listens to it.
import { existsSync, writeFileSync } from 'node:fs';
import { readJson, writeJson, sha256 } from './files.js';
import { FFMPEG, run } from './media.js';
import { readFinished, recoverProject, settleProject, watchRefusals, RefusedError, refusedForSure, safeError } from './sogni.js';

/** Qwen3-TTS on Sogni: three checkpoints, and what each accepts. */
export const SPEECH_MODELS = {
  clone: 'qwen3_tts_1.7b_voice_clone_bf16',   // a voice from 3–30 s of a recording you own, plus its transcript
  design: 'qwen3_tts_1.7b_voice_design_bf16', // a new voice from a description
  studio: 'qwen3_tts_1.7b_custom_voice_bf16', // one of nine studio voices, optional style direction
};
export const STUDIO_VOICES = ['serena', 'vivian', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan'];
export const SPEECH_LIMITS = { script: 4096, instruct: 512, transcript: 1024, referenceSeconds: [3, 30] };

/** ACE-Step 1.5 XL: instrumental when no lyrics are sent. Covered by Unlimited plans. */
export const MUSIC_MODELS = {
  ace_step_1_5_xl_turbo: { id: 'ace_step_1.5_xl_turbo', steps: 8, shift: 3 },
  ace_step_1_5_xl_sft: { id: 'ace_step_1.5_xl_sft', steps: 50, shift: 3, guidance: 7 },
};
export const musicModel = id => Object.values(MUSIC_MODELS).find(m => m.id === (id ?? 'ace_step_1.5_xl_turbo'));

/**
 * Render one audio job under a receipt at `journalPath`, or resume the one
 * already submitted. Returns { journal, bytes }; the caller saves the bytes.
 */
export async function renderAudio({ session, journalPath, request, record, contentType, say }) {
  let journal = existsSync(journalPath) ? readJson(journalPath) : null;
  if (journal?.status === 'submitting' && !journal.projectId) {
    throw new Error(`${journalPath} was being submitted when the last run stopped, so whether Sogni received it is unknown. Check your recent jobs at https://app.sogni.ai; if nothing is there, delete that file and run again.`);
  }
  if (journal?.status === 'failed') throw new Error(`This job failed before (${journal.failure?.message ?? 'unknown'}). Re-take it with --retake.`);
  const { client, billing } = session;
  const refusals = watchRefusals(client);
  let project = null;
  try {
    if (!journal) {
      journal = { ...record, model: request.modelId, appId: session.appId, pid: process.pid, billing,
        status: 'submitting', startedAt: new Date().toISOString() };
      writeJson(journalPath, journal, { exclusive: true });
      try {
        project = await refusals.creating(() => client.projects.create({
          type: 'audio', network: 'fast', numberOfMedia: 1, tokenType: billing.tokenType,
          ...(billing.mode && billing.mode !== 'auto' ? { billingMode: billing.mode } : {}),
          ...request,
        }));
      } catch (error) {
        const refused = refusals.unassigned();
        if (!refusedForSure(error, refused)) {
          // No answer: Sogni may have the job. The receipt stays `submitting`, so no run sends it again.
          throw safeError(error, `The submission got no answer, so whether Sogni received it is unknown (${journalPath} keeps it reserved; the next run says how to check)`);
        }
        journal = { ...journal, status: 'failed', failure: refused ?? { code: Number.isFinite(error?.code) ? error.code : null, message: safeError(error).message } };
        writeJson(journalPath, journal);
        throw refused ? new RefusedError(refused) : safeError(error, 'Sogni refused the job');
      }
      journal = { ...journal, status: 'submitted', projectId: project.id, submittedAt: new Date().toISOString() };
      writeJson(journalPath, journal);
      say?.(`submitted ${project.id}`);
    } else {
      say?.(`resuming ${journal.projectId}`);
    }
    let finished;
    try {
      finished = await waitForAudio(client, project ? { project } : { projectId: journal.projectId, ownerPid: journal.pid }, { refusals, say });
    } catch (error) {
      if (error instanceof RefusedError) {
        journal = { ...journal, status: 'failed', failure: error.failure };
        writeJson(journalPath, journal);
      }
      throw error;
    }
    const response = await fetch(finished.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Downloading the result failed (HTTP ${response.status}); run the command again to retry the download`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 64 * 1024 * 1024) throw new Error('The result is larger than expected');
    journal = { ...journal, status: 'completed', completedAt: new Date().toISOString(), jobId: finished.jobId,
      elapsedSeconds: (Date.now() - Date.parse(journal.startedAt)) / 1000, rawSha256: sha256(bytes), rawBytes: bytes.length, contentType };
    writeJson(journalPath, journal);
    return { journal, bytes };
  } finally {
    refusals.stop();
  }
}

/**
 * Wait for an audio project over the socket (see waitForProject in sogni.js):
 * `project` for one this client created, `projectId` (and the journal's
 * `ownerPid`) for one an earlier run submitted. Returns { url, jobId }.
 */
export async function waitForAudio(client, { project, projectId, ownerPid }, { refusals, say, timeoutMs = 20 * 60_000, sleep, connectAs } = {}) {
  const id = project?.id ?? projectId;
  let session = null;
  try {
    let tracked = project;
    if (!tracked) {
      const recovered = await recoverProject(client, id, { ownerPid, connectAs });
      tracked = recovered.project ?? null;
      session = recovered.session ?? null;
    }
    if (tracked) {
      const urls = await settleProject(tracked, { refusals, timeoutMs, onStatus: say });
      const job = tracked.jobs?.find(j => j.status === 'completed') ?? tracked.jobs?.[0];
      if (urls?.[0]) return { url: urls[0], jobId: job?.id ?? null };
    }
    // Finished while nobody listened: one look at its result, which mints the download URL.
    const result = await readFinished(() => client.projects.getResult(id, { kind: 'audio' }), { sleep });
    if (!result) throw new Error(`Project ${id} is no longer running and Sogni has no result for it. Check your recent jobs at https://app.sogni.ai`);
    const job = result.jobs?.find(j => j.status === 'completed');
    if (result.status === 'completed' && job?.url) return { url: job.url, jobId: job.id };
    if (result.finished) {
      const reason = result.jobs?.find(j => j.reason)?.reason ?? job?.urlUnavailable;
      throw new RefusedError({ code: null, message: `the job ${result.status}${reason ? `: ${reason}` : ''} (project ${id})` });
    }
    throw new Error(`Project ${id} is ${result.status}; run the command again to pick it up`);
  } finally {
    session?.close();
  }
}

/** Mono 24 kHz samples of an audio file. */
export async function samples(path) {
  const bytes = await run(FFMPEG, ['-v', 'error', '-nostdin', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '24000', '-']);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

/**
 * Pauses: at least 150 ms whose level, in 10 ms steps, stays under −38 dB.
 * (ffmpeg's silencedetect needs every sample quiet, so a breath inside a
 * pause hides it and a subtitle comes up a sentence late.)
 */
export function pauses(pcm, rate = 24000) {
  const frame = rate / 100, quiet = [];
  for (let i = 0; i < pcm.length; i += frame) {
    let energy = 0; const end = Math.min(i + frame, pcm.length);
    for (let j = i; j < end; j++) energy += pcm[j] * pcm[j];
    quiet.push(20 * Math.log10(Math.sqrt(energy / Math.max(1, end - i)) / 32768 + 1e-9) < -38);
  }
  const found = [];
  for (let i = 0; i < quiet.length; i++) {
    if (!quiet[i]) continue;
    let j = i; while (j < quiet.length && quiet[j]) j++;
    if (j - i >= 15) found.push({ start: i / 100, end: Math.min(j / 100, pcm.length / rate) });
    i = j;
  }
  return found;
}

/**
 * Whether a take ends cleanly. Qwen3-TTS sometimes stops partway through the
 * last word: a real ending fades into silence, a clipped one drops from speech
 * to nothing in a step or two. Clean = the level falls from speech to near
 * silence over at least 40 ms and the last 20 ms are quiet. (Qwen3-TTS often
 * ends a clip ~120 ms after a natural fade, so silence length is no signal.)
 */
export function ending(pcm, rate = 24000) {
  let last = -1;
  for (let i = pcm.length - 1; i >= 0; i--) if (Math.abs(pcm[i]) > 328) { last = i; break; }
  let finalPeak = 0;
  for (let i = Math.max(0, pcm.length - rate / 50); i < pcm.length; i++) finalPeak = Math.max(finalPeak, Math.abs(pcm[i]) / 32768);
  const tailMs = last < 0 ? 0 : Math.round((pcm.length - 1 - last) / (rate / 1000));
  // Level in 10 ms steps. From the last step that still sounds like speech
  // (>= -35 dB), count the steps it takes to fall to near silence (<= -55 dB).
  // A voice that fades takes several; a cut word falls in one or two, and a
  // take that ends while still sounding never gets there.
  const frame = rate / 100, levels = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let energy = 0;
    for (let j = i; j < i + frame; j++) energy += pcm[j] * pcm[j];
    levels.push(20 * Math.log10(Math.sqrt(energy / frame) / 32768 + 1e-9));
  }
  let lastSpeech = -1;
  for (let i = levels.length - 1; i >= 0; i--) if (levels[i] >= -35) { lastSpeech = i; break; }
  let fadeSteps = null;
  if (lastSpeech >= 0) {
    const quiet = levels.findIndex((db, i) => i > lastSpeech && db <= -55);
    fadeSteps = quiet < 0 ? null : quiet - lastSpeech;
  }
  const clean = lastSpeech >= 0 && fadeSteps !== null && fadeSteps >= 4 && finalPeak < 0.005;
  return { tailMs, finalPeak: +finalPeak.toFixed(4), fadeMs: fadeSteps === null ? null : fadeSteps * 10, clean };
}

/**
 * A start and end time for every line: speech runs between the leading and
 * trailing silence, and each line boundary is the pause nearest where the
 * line's share of the words puts it (longer pauses preferred). Too few pauses:
 * split by length.
 */
export function lineTimes(lines, found, seconds) {
  const lead = found[0]?.start === 0 ? found[0].end : 0;
  const tail = found.length && found.at(-1).end >= seconds - 0.05 ? found.at(-1).start : seconds;
  const inner = found.filter(p => p.start > lead + 0.05 && p.end < tail - 0.05);
  const total = lines.reduce((sum, text) => sum + text.length, 0) || 1;
  const cuts = [];
  let from = 0, share = 0;
  for (let index = 0; index < lines.length - 1; index++) {
    share += lines[index].length;
    const expected = lead + (tail - lead) * share / total;
    let best = -1, bestScore = Infinity;
    for (let candidate = from; candidate < inner.length - (lines.length - 2 - index); candidate++) {
      const p = inner[candidate];
      const score = Math.abs((p.start + p.end) / 2 - expected) - 0.6 * (p.end - p.start);
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    if (best < 0) break;
    cuts.push(inner[best]); from = best + 1;
  }
  let timing, split;
  if (cuts.length === lines.length - 1) {
    split = 'pauses';
    timing = lines.map((text, i) => ({ text, start: i ? cuts[i - 1].end : lead, end: i < cuts.length ? cuts[i].start : tail }));
  } else {
    split = 'length';
    let at = lead;
    timing = lines.map(text => { const span = (tail - lead) * text.length / total; const line = { text, start: at, end: at + span }; at += span; return line; });
  }
  return { split, lines: timing.map(l => ({ text: l.text, start: +l.start.toFixed(3), end: +l.end.toFixed(3) })) };
}

export const writeBytes = (path, bytes) => writeFileSync(path, bytes);
