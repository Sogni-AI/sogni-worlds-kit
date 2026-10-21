// Close looks: of the candidates `node world reveals` painted for one object,
// the one that shows the change its plan describes in the same room. The room
// score is measured (reveals.js roomKept); the change and the writing are
// judged by eye.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/files.js';
import { imagePart } from '../lib/llm.js';
import { ROOM_KEPT } from '../commands/reveals.js';

const PICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['best', 'acceptable', 'why'],
  properties: { best: { type: 'integer', minimum: 1, maximum: 4 }, acceptable: { type: 'boolean' }, why: { type: 'string', minLength: 5 } },
};

/** The candidate to keep for `key`, as { n, why }, or null when none is good enough. */
export async function pickCloseLook(llm, { paths, key, paint }) {
  const dir = join(paths.reveals, 'candidates');
  const receipt = readJson(join(dir, `${key}.json`), null);
  if (!receipt) return null;
  const candidates = receipt.sha256.map((_, i) => ({ n: i + 1, file: join(dir, `${key}-${i + 1}.png`), kept: receipt.roomKept?.[i] ?? null }))
    .filter(c => existsSync(c.file) && (c.kept === null || c.kept >= ROOM_KEPT));
  if (!candidates.length) return null;
  const answer = await llm.json({
    system: 'You are the art director. You compare close-up pictures with the picture they were made from, strictly and literally.',
    user: [
      { type: 'text', text: [
        'The first picture is a zoomed crop of a place. Each candidate after it should be the same picture with only this change:',
        paint,
        'Pick the candidate where the change is shown plainly and correctly, everything else (furniture, walls, lamps, people, their hands and faces) stays exactly as in the crop, and any writing reads exactly the words the change names, letter for letter. It is acceptable only if all of that holds. Read every letter before you answer.',
        'Reply with JSON {"best": the candidate number, "acceptable": true|false, "why": "one sentence"}.',
      ].join('\n') },
      { type: 'text', text: 'The zoomed crop:' }, await imagePart(join(dir, `${key}.zoom.png`)),
      ...(await Promise.all(candidates.map(async c => [{ type: 'text', text: `Candidate ${c.n}:` }, await imagePart(c.file)]))).flat(),
    ],
    schema: PICK_SCHEMA,
    purpose: `pick-close-look-${key}`,
    maxTokens: 2000,
    temperature: 0.1,
  });
  const chosen = candidates.find(c => c.n === answer.best);
  return answer.acceptable && chosen ? { n: chosen.n, why: answer.why } : null;
}
