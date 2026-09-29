import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitTake, UnknownOutcomeError } from '../cli/commands/render.js';
import { renderAudio } from '../cli/lib/audio.js';
import { RefusedError } from '../cli/lib/sogni.js';
import { tempDir } from './helpers.js';

const dir = tempDir('submit');
const refusals = (refusal = null) => ({ unassigned: () => refusal });
const reserve = name => {
  const journalPath = join(dir, `${name}.json`);
  const journal = { film: name, status: 'submitting', projectId: null };
  writeFileSync(journalPath, JSON.stringify(journal));
  return { journal, journalPath };
};
const saved = path => JSON.parse(readFileSync(path, 'utf8'));
const transportError = () => Object.assign(new Error('socket hang up'), { cause: 'ECONNRESET' });

test('a create that gets no answer leaves the take reserved, never failed (so it is never sent twice)', async () => {
  const { journal, journalPath } = reserve('lost');
  await assert.rejects(submitTake({ create: async () => { throw transportError(); }, refusals: refusals(), journal, journalPath }), UnknownOutcomeError);
  assert.equal(saved(journalPath).status, 'submitting');
  assert.equal(saved(journalPath).projectId, null);
});

test('a 5xx is not a refusal either: the job may exist', async () => {
  const { journal, journalPath } = reserve('five-hundred');
  await assert.rejects(submitTake({ create: async () => { throw Object.assign(new Error('bad gateway'), { status: 502 }); }, refusals: refusals(), journal, journalPath }), UnknownOutcomeError);
  assert.equal(saved(journalPath).status, 'submitting');
});

test('a refusal, a server error code or a 4xx is a known outcome: the take is failed', async () => {
  for (const [name, error, refusal] of [
    ['refused-event', transportError(), { code: 4087, message: 'fair use' }],
    ['server-code', Object.assign(new Error('insufficient'), { code: 4024 }), null],
    ['four-hundred', Object.assign(new Error('bad request'), { status: 400 }), null],
  ]) {
    const { journal, journalPath } = reserve(name);
    await assert.rejects(submitTake({ create: async () => { throw error; }, refusals: refusals(refusal), journal, journalPath }), RefusedError, name);
    assert.equal(saved(journalPath).status, 'failed', name);
  }
});

test('a successful create records the project id before anything else', async () => {
  const { journal, journalPath } = reserve('ok');
  const result = await submitTake({ create: async () => ({ id: 'PROJECT-1' }), refusals: refusals(), journal, journalPath });
  assert.equal(result.projectId, 'PROJECT-1');
  assert.equal(saved(journalPath).status, 'submitted');
});

test('narration and music follow the same rule: no answer means reserved, and the next run stops', async () => {
  const journalPath = join(dir, 'voice.json');
  const session = { billing: { mode: 'subscription', tokenType: 'spark' }, client: { projects: { create: async () => { throw transportError(); } } } };
  await assert.rejects(renderAudio({ session, journalPath, request: { modelId: 'm' }, record: { place: 'a' }, contentType: 'audio/wav' }), /unknown/);
  assert.equal(saved(journalPath).status, 'submitting');
  await assert.rejects(renderAudio({ session, journalPath, request: { modelId: 'm' }, record: { place: 'a' }, contentType: 'audio/wav' }), /unknown/);
});
