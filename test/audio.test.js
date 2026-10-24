import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ending } from '../cli/lib/audio.js';

const RATE = 24000;
/** A 220 Hz tone whose level (dBFS) follows `levels`, one value per 10 ms step. */
function tone(levels) {
  const frame = RATE / 100;
  const pcm = new Int16Array(levels.length * frame);
  levels.forEach((db, step) => {
    const amp = db === null ? 0 : 32767 * 10 ** (db / 20) * Math.SQRT2;
    for (let i = 0; i < frame; i++) {
      const n = step * frame + i;
      pcm[n] = Math.round(Math.max(-32768, Math.min(32767, amp * Math.sin((2 * Math.PI * 220 * n) / RATE))));
    }
  });
  return pcm;
}
const speech = seconds => Array(seconds * 100).fill(-18);

test('a take whose voice fades away over ~150 ms ends cleanly, even with little silence after', () => {
  // The shape Qwen3-TTS gave both canary takes on 2026-09-29: -20 dB fading to -80 dB over 15 steps.
  const fade = [-20, -22, -24, -26, -29, -31, -34, -37, -39, -43, -46, -49, -52, -57, -64, -72, -80, -82];
  const result = ending(tone([...speech(2), ...fade, ...Array(2).fill(null)]));
  assert.equal(result.clean, true, JSON.stringify(result));
});

test('a voice that drops to nothing in one step is clipped', () => {
  const result = ending(tone([...speech(2), -18, -18, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]));
  assert.equal(result.clean, false);
});

test('a take that ends while the voice is still sounding is clipped', () => {
  const result = ending(tone(speech(2)));
  assert.equal(result.clean, false);
});

test('a place whose lines change voice is a conversation: one run per speaker, joined on one timeline', async () => {
  const { joinParts, lineText, voiceRuns, TURN_GAP } = await import('../cli/commands/narrate.js');
  const place = { narration: { voice: 'caller', lines: ['You took the pill.', 'Listen to me.', { voice: 'hero', text: 'Who is this?' }, { voice: 'caller', text: 'A friend.' }] } };
  assert.deepEqual(voiceRuns(place), [
    { voice: 'caller', lines: ['You took the pill.', 'Listen to me.'] },
    { voice: 'hero', lines: ['Who is this?'] },
    { voice: 'caller', lines: ['A friend.'] },
  ]);
  assert.equal(voiceRuns({ narration: { voice: 'narrator', lines: ['One.', 'Two.'] } }).length, 1, 'a monologue stays one take');
  assert.equal(lineText({ voice: 'x', text: 'Hi.' }), 'Hi.');
  const timeline = joinParts([
    { speaker: 'Caller', seconds: 3, lines: [{ text: 'a', start: 0.1, end: 1.4 }, { text: 'b', start: 1.6, end: 2.9 }] },
    { speaker: 'Hero', seconds: 1, lines: [{ text: 'c', start: 0.05, end: 0.9 }] },
  ]);
  assert.deepEqual(timeline.lines.map(l => [l.speaker, l.start]), [['Caller', 0.1], ['Caller', 1.6], ['Hero', +(3 + TURN_GAP + 0.05).toFixed(3)]]);
  assert.equal(timeline.seconds, +(3 + TURN_GAP + 1).toFixed(3));
});
