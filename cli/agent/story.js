// The story editor: a fictional world's plot and every word a visitor meets,
// read in story order by a model playing a demanding editor, who says plainly
// what does not work yet. The kit only gathers the words (lint checks the
// plot's shape); whether the story holds is the model's judgement.
import { createHash } from 'node:crypto';

const str = (min, max) => ({ type: 'string', ...(min ? { minLength: min } : {}), ...(max ? { maxLength: max } : {}) });

/** What makes a world's story work, in the editor's words (docs/writing-the-story.md explains each). */
export const STORY_CRAFT = [
  'It keeps the promise of its genre and of what the person asked for: a murder mystery has a death that matters, suspects, lies and a solution; a ghost story builds dread; a comedy keeps paying off its jokes; a children\'s adventure has wonder and a brave choice.',
  'It has a shape: the first place hooks the visitor and starts the story (a body, a theft, a summons, a door that should not be open); every place in the middle changes what the visitor knows or wants, and the stakes rise; something near the middle turns the story; the end puts the visitor before a real choice and pays it off.',
  'Under it lies one consistent truth, what really happened, which the visitor can piece together from what they see and hear.',
  'Its twists surprise and are fair: each is planted with clues the visitor could have noticed earlier (seen in a picture or said in a line), and recolours what came before. A twist from nowhere is a cheat; a twist announced early is no twist.',
  'Every click moves the story: it finds a clue, turns a suspicion, costs something, or shows who someone really is. A click that only decorates, or whose film undoes itself, wastes the visitor\'s trust.',
  'No beat happens twice: not the same kind of encounter, the same trick, the same reveal or the same phrase in two places.',
  'Each person has one name, spelled the same everywhere, and stays the same person (what they know, what they want, how they speak).',
  'The narrator speaks in the genre\'s voice, in short spoken lines that carry facts (a name, a time, a wound, a lie), not mood words, and never gives a twist away before it lands.',
  'Every ending is earned: a fatal choice is a real temptation with a reason to take it, and each ending says what the choice cost.',
];

const CRITIQUE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['people', 'beats', 'verdict', 'summary', 'findings'],
  properties: {
    // Written out before the verdict, so a changed name or a beat used twice is in front of the editor.
    people: {
      type: 'array', maxItems: 24,
      items: { type: 'object', additionalProperties: false, required: ['person', 'calledAs'], properties: { person: str(2, 120), calledAs: { type: 'array', maxItems: 8, items: str(1, 80) } } },
    },
    beats: {
      type: 'array', maxItems: 80,
      items: { type: 'object', additionalProperties: false, required: ['where', 'kind', 'adds'], properties: { where: str(2, 80), kind: str(2, 60), adds: str(2, 200) } },
    },
    verdict: { type: 'string', enum: ['strong', 'needs work', 'weak'] },
    summary: str(20, 900),
    findings: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['severity', 'where', 'problem', 'fix'],
        properties: { severity: { type: 'string', enum: ['fix', 'consider'] }, where: str(2, 80), problem: str(10, 500), fix: str(10, 600) },
      },
    },
  },
};

/** A fingerprint of the words the editor reads, so `next` knows when they changed since the last read. */
export const storyWords = plan => createHash('sha256').update(storyText(plan)).digest('hex');

const lineText = line => (typeof line === 'string' ? line : line?.text ?? '');

/** Every word a visitor meets, in the order they meet it, under the plot it should serve. */
export function storyText(plan) {
  const plot = plan.plot ?? {};
  const out = [`Title: ${plan.title ?? plan.id}${plan.subtitle ? ` — ${plan.subtitle}` : ''}`];
  if (plan.intro) out.push(`Title card: ${Object.values(plan.intro).filter(Boolean).join(' / ')}`);
  out.push('', '# The plot (the creator\'s; visitors never read it)');
  if (plot.promise) out.push(`Promise: ${plot.promise}`);
  if (plot.truth) out.push(`What really happened: ${plot.truth}`);
  if (plot.cast?.length) out.push(`Cast: ${plot.cast.map(p => `${p.name} (${p.who})`).join('; ')}`);
  for (const [id, beat] of Object.entries(plot.beats ?? {})) out.push(`Beat at ${id}: ${beat}`);
  for (const t of plot.twists ?? []) out.push(`Twist at ${t.at}: ${t.twist} — planted: ${(t.clues ?? []).map(c => `${c.at}: ${c.clue}`).join('; ') || 'nothing'}`);
  out.push('', `# What the visitor meets${plan.order === 'linear' ? ', in story order' : ' (a free world: any order)'}`);
  const titleOf = id => plan.places.find(p => p.id === id)?.title ?? id;
  for (const place of plan.places) {
    out.push('', `## ${place.id}: ${place.title ?? ''}${place.chapter ? ` (${place.chapter})` : ''}${place.ending ? ` — an ending (${place.ending.kind})` : ''}`);
    if (place.caption) out.push(`Caption: ${place.caption}`);
    for (const line of place.narration?.lines ?? []) out.push(`Narrator: ${lineText(line)}`);
    if (place.ending) out.push(`Ending card: ${place.ending.title ?? ''}: ${place.ending.text ?? ''}`);
    for (const o of place.objects ?? []) {
      const what = o.goes ? `goes to ${titleOf(o.goes)}${o.shortcut ? ' (a shortcut)' : ''}` : o.reveal ? 'a close look' : o.collect ? 'a collectible' : 'a moment here';
      out.push(`- Click "${o.label ?? o.id}"${o.hint ? ` [${o.hint}]` : ''}: ${what}. ${o.film?.idea ?? ''}`.trim());
      if (o.reveal?.line) out.push(`  Narrator over the close look: ${o.reveal.line}`);
    }
  }
  return out.join('\n');
}

/** The editor's verdict on a fictional world's story: { verdict, summary, findings: [{ severity, where, problem, fix }] }. */
export async function critiqueStory(llm, { plan, about = null, outline = false, purpose = 'story' }) {
  return llm.json({
    system: 'You are a demanding story editor for interactive films: you have read every great mystery, thriller, ghost story and fable, and you tell writers exactly what does not work yet and how to fix it. You praise nothing that is not earned.',
    user: [
      'Below is a fictional interactive world: a visitor moves from picture to picture by clicking things; each click plays a short film, and a narrator speaks a few lines at each place. Read the plot and then every word the visitor meets, in order, and judge the story as a visitor would live it.',
      about ? `What the creator asked for: ${about}` : null,
      outline ? 'This is the story\'s outline, written before any picture, click or line: judge the plot and its beats (they become the places, clicks and lines), not the words still to be written.' : null,
      '',
      'What makes such a story work:',
      ...STORY_CRAFT.map((rule, i) => `${i + 1}. ${rule}`),
      '',
      'Reply with JSON. First "people": every person in the story, with "calledAs": every name, title or spelling the words use for them (a person called two different names is a finding). Then "beats": for every place and every click, in order, "where", "kind" (what sort of beat it is, in two or three words: "seduction", "body found", "interrogation", "clue: a key", "chase") and "adds" (what the visitor knows or feels afterwards that they did not before, or "nothing"). Look down the kinds: the same kind twice is a finding. Then "verdict" ("strong" only if a demanding reader would be gripped and satisfied, "needs work", or "weak"); "summary" (two or three sentences: what the story is and the biggest thing it lacks); "findings": the real problems, most important first, each with "severity" ("fix" for what breaks the story or the rules above, always including a twist with no planted clue, a click that adds nothing, a beat used twice, a person called by two names, and a line that gives a twist away; "consider" for what would make it better), "where" (a place id, "place-object", or "plot"), "problem" (what is wrong, quoting the words), and "fix" (the concrete change: the line, clue, beat or twist to write). Do not ask for more places or clicks than the world has; fix the story within them.',
      '',
      storyText(plan),
    ].filter(line => line !== null).join('\n'),
    schema: CRITIQUE_SCHEMA,
    purpose,
    maxTokens: 14000,
    temperature: 0.3,
  });
}
