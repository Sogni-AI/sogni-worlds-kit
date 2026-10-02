// A world without photographs: the agent writes a short bible from the
// person's concept (places, characters, look, how places connect), paints
// each place with Krea 2 (Identity Edit when a character the person supplied
// must appear), looks at the candidates and keeps the best. The kept pictures
// go into photos/ and are ingested exactly like photographs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imagePart } from '../lib/llm.js';
import { paint, PAINT_SIZES } from '../lib/paint.js';
import { readJson, writeJson } from '../lib/files.js';

const str = (min, max) => ({ type: 'string', ...(min ? { minLength: min } : {}), ...(max ? { maxLength: max } : {}) });

function bibleSchema(count) {
  return {
    type: 'object', additionalProperties: false,
    required: ['title', 'subtitle', 'story', 'style', 'characters', 'places', 'links'],
    properties: {
      title: str(2, 60),
      subtitle: str(2, 140),
      story: str(80, 1200),
      style: str(20, 600),
      characters: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'look', 'reference'], properties: { id: str(2, 24), name: str(1, 40), look: str(20, 600), reference: { type: 'integer', minimum: -1, maximum: 3 } } } },
      places: {
        type: 'array', minItems: count, maxItems: count + 3,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'title', 'idea', 'style', 'prompt', 'characters', 'clickables', 'ending', 'collectible'],
          properties: {
            id: str(2, 24),
            title: str(2, 60),
            idea: str(10, 500),
            style: str(0, 400),
            prompt: str(150, 2500),
            characters: { type: 'array', items: { type: 'string' } },
            clickables: { type: 'array', minItems: 2, maxItems: 5, items: str(3, 120) },
            ending: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'text'], properties: { kind: { type: 'string', enum: ['none', 'death', 'end'] }, title: str(0, 60), text: str(0, 200) } },
            collectible: str(0, 80),
          },
        },
      },
      links: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'via', 'to'], properties: { from: str(2), via: str(3, 160), to: str(2) } } },
    },
  };
}

function bibleProblems(bible, { count, mechanics }) {
  const problems = [];
  const ids = bible.places.map(p => p.id);
  const set = new Set(ids);
  if (set.size !== ids.length) problems.push('place ids must be unique');
  for (const id of ids) if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`place id "${id}" must be lower-case letters, digits and dashes`);
  const playable = bible.places.filter(p => p.ending.kind === 'none');
  if (playable.length !== count) problems.push(`there must be exactly ${count} places with "ending": {"kind": "none"} (there are ${playable.length}); endings are extra`);
  if (bible.places[0]?.ending.kind !== 'none') problems.push('the first place is where the visitor starts; it cannot be an ending');
  const charIds = new Set(bible.characters.map(c => c.id));
  for (const place of bible.places) {
    for (const c of place.characters) if (!charIds.has(c)) problems.push(`place "${place.id}" names character "${c}", which is not in "characters"`);
    if (/\b(text|caption|logo|watermark|sign that reads)\b/i.test(place.prompt) && !/legible/i.test(place.prompt)) { /* allowed: described signage */ }
  }
  for (const link of bible.links) {
    if (!set.has(link.from) || !set.has(link.to)) problems.push(`link ${link.from} → ${link.to} names a place that does not exist`);
    if (link.from === link.to) problems.push(`link ${link.from} → ${link.to} goes nowhere`);
    const from = bible.places.find(p => p.id === link.from);
    if (from && from.ending.kind !== 'none') problems.push(`"${link.from}" is an ending, so nothing leads out of it`);
  }
  const reachable = new Set([bible.places[0]?.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const link of bible.links) if (reachable.has(link.from) && !reachable.has(link.to)) { reachable.add(link.to); changed = true; }
  }
  for (const id of ids) if (!reachable.has(id)) problems.push(`nothing leads to "${id}"; add a link to it`);
  for (const place of playable) if (!bible.links.some(l => l.from === place.id) && place !== playable.at(-1)) problems.push(`"${place.id}" has no way out; add a link from it`);
  if (mechanics?.endings && !bible.places.some(p => p.ending.kind === 'death')) problems.push('the person wants fatal choices: at least one place must be a death ending ("kind": "death"), reached by a link');
  if (mechanics?.collectibles && !bible.places.some(p => p.collectible)) problems.push('the person wants collectible figures: name at least one "collectible" (a small character or object really in that place\'s picture)');
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const place of bible.places) {
    if (place.collectible && !place.clickables.some(c => same(c, place.collectible))) problems.push(`place "${place.id}": its "collectible" must be copied exactly from its clickables (${JSON.stringify(place.clickables)})`);
    for (const link of bible.links.filter(l => l.from === place.id)) {
      if (!place.clickables.some(c => same(c, link.via))) problems.push(`link ${link.from} → ${link.to}: "via" must be copied exactly from "${place.id}"'s clickables (${JSON.stringify(place.clickables)})`);
    }
  }
  return problems;
}

/** Write the world's bible from the person's concept. */
export async function writeBible(llm, { brief, referenceParts }) {
  const paintBrief = brief.paint;
  const count = paintBrief.places ?? 3;
  const user = [
    { type: 'text', text: [
      'A person wants an interactive cinematic world: a few painted places, each a single picture that quietly comes alive. Clicking a thing in a picture plays a short film that carries the visitor to another place (or makes a small moment happen there). Plan it.',
      `Their concept, in their words: ${paintBrief.concept}`,
      brief.about ? `What it is about: ${brief.about}` : null,
      brief.title ? `Its title: ${brief.title}` : null,
      paintBrief.places ? `How many places: ${count} (plus any endings).` : null,
      paintBrief.mature ? 'It is 18+: the person has authorised graphic horror, gore and frightening imagery. Plan it at that intensity.' : null,
      brief.mechanics?.endings ? 'Fatal choices: some clicks kill the visitor. Each death is its own ending place (a picture of what happened, "ending": {"kind": "death", "title": "You …", "text": "one line"}), reached by a link from the room where the fatal choice is made. The visitor can rewind and choose again.' : null,
      brief.mechanics?.collectibles ? 'Collectible figures: small characters or objects hidden in places that the visitor can collect by clicking them. Name one per place in "collectible" where it fits (copied exactly from that place\'s clickables).' : null,
      referenceParts.length ? 'The person supplied reference pictures of their character(s), shown below in order (reference 0, 1, …). Use "reference" on a character to say which picture shows them (-1 for none). Describe each character\'s look exactly as the reference shows it.' : null,
      '',
      'Reply with JSON:',
      '- "title", "subtitle", "story" (one paragraph: what the world is, its tone, who is in it, how the visitor moves through it).',
      '- "style": the visual style every picture shares (medium, palette, lighting, lens or technique), as words to append to an image prompt. If places deliberately differ in style, put each place\'s own style in its "style" and keep this one for what they share.',
      '- "characters": recurring characters with a precise visual description.',
      '- "places": in the order a visitor meets them, the first is where they start. Each has "id", "title", "idea" (what the place is and what can happen here), "style" (its own style or ""), "prompt" (a detailed image prompt for this single picture: the composition, viewpoint and framing (a wide shot unless it must be close), where each thing is in the frame, the light; 2–4 distinct clickable things clearly visible and well separated, each a single object; any character small or mid-sized in the scene, not a portrait; no text, captions or logos), "characters" (ids present), "clickables" (the clickable things, as named in the prompt), "ending" ({"kind": "none", "title": "", "text": ""} unless it is an ending), "collectible" ("" if none).',
      '- "links": how places connect, each {"from", "via" (the clickable thing in "from" that causes the journey, copied exactly from its clickables), "to"}. Every place except endings has at least one way out (the last ordinary place may lead back to the first); every place can be reached from the first.',
    ].filter(Boolean).join('\n') },
    ...referenceParts,
  ];
  return llm.json({
    system: 'You are the art director and story planner of an interactive cinematic world. You plan few places but make each one rich, specific and visually striking, with clear clickable things.',
    user,
    schema: bibleSchema(count),
    check: bible => bibleProblems(bible, { count, mechanics: brief.mechanics }),
    rounds: 4,
    purpose: 'bible',
    maxTokens: 24000,
    think: true,
  });
}

const PICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['best', 'acceptable', 'problems', 'prompt'],
  properties: { best: { type: 'integer', minimum: 0, maximum: 5 }, acceptable: { type: 'boolean' }, problems: { type: 'string' }, prompt: { type: 'string' } },
};

/** Choose the best candidate, or say what to change and paint again. */
async function pick(llm, { place, bible, candidates, referenceParts, fullPrompt }) {
  const cast = bible.characters.filter(c => place.characters.includes(c.id));
  return llm.json({
    system: 'You are the art director. You judge painted candidates for one place in an interactive world, strictly.',
    user: [
      { type: 'text', text: [
        `The place "${place.id}" — ${place.title}: ${place.idea}`,
        `It must clearly show these clickable things, each a single, separate object: ${place.clickables.join('; ')}.`,
        cast.length ? `Characters in it: ${cast.map(c => `${c.name}: ${c.look}`).join(' | ')}. They must match their description${referenceParts.length ? ' and the reference picture(s) shown last' : ''} exactly (shape, colours, accessories).` : null,
        `The prompt that painted them: ${fullPrompt}`,
        `Below are ${candidates.length} candidates (candidate 0, 1, …). Pick the best. It is acceptable only if every clickable thing is clearly visible and separate, every character matches, there is no text, caption, logo, watermark or garbled lettering, no extra limbs or broken anatomy, and it would make a striking first picture of a film.`,
        'Reply with JSON {"best": index, "acceptable": true|false, "problems": "what is wrong with the best one, or \'\'", "prompt": "if not acceptable: the whole image prompt rewritten to fix those problems; else \'\'"}.',
      ].filter(Boolean).join('\n') },
      ...(await Promise.all(candidates.map(async (bytes, i) => [{ type: 'text', text: `Candidate ${i}:` }, await imagePart(bytes)]))).flat(),
      ...referenceParts.slice(0, 2),
    ],
    schema: PICK_SCHEMA,
    purpose: `pick-${place.id}`,
    maxTokens: 4000,
    temperature: 0.2,
  });
}

/**
 * Paint every place in the bible into photos/, numbered in order. Resumable:
 * a place whose photo exists is skipped. Returns the place list with files.
 */
export async function paintPlaces(llm, session, { paths, brief, bible, references, say }) {
  const canvas = brief.paint.canvas ?? '1344x768';
  const [width, height] = PAINT_SIZES[canvas] ?? PAINT_SIZES['1344x768'];
  const dir = join(paths.dir, 'agent', 'paint');
  mkdirSync(dir, { recursive: true });
  mkdirSync(paths.photos, { recursive: true });
  const record = readJson(join(dir, 'paint.json'), {});
  const referenceParts = (await Promise.all(references.map(async (ref, i) => [{ type: 'text', text: `Reference ${i} (${ref.who}):` }, await imagePart(ref.file)]))).flat();
  const out = [];
  for (const [index, place] of bible.places.entries()) {
    const file = join(paths.photos, `${String(index + 1).padStart(2, '0')}-${place.id}.png`);
    if (existsSync(file)) { out.push({ ...place, file }); continue; }
    const cast = bible.characters.filter(c => place.characters.includes(c.id));
    const refs = cast.filter(c => c.reference >= 0 && references[c.reference]).map(c => readFileSync(references[c.reference].file)).slice(0, 2);
    let prompt = [
      place.prompt,
      cast.length ? `Characters: ${cast.map(c => `${c.name}, ${c.look}`).join('; ')}.` : null,
      `Style: ${[bible.style, place.style].filter(Boolean).join('; ')}.`,
    ].filter(Boolean).join('\n');
    let chosen = null;
    for (let round = 1; round <= 3 && !chosen; round++) {
      say.step(`Painting ${place.id} (round ${round}, ${refs.length ? 'Identity Edit with the character reference' : 'Krea 2 Turbo'})`);
      const { images, modelId, projectId } = await paint(session, { prompt, width, height, context: refs, count: 3, dark: Boolean(brief.paint.mature) });
      images.forEach((bytes, i) => writeFileSync(join(dir, `${place.id}-r${round}-${i}.png`), bytes));
      const verdict = await pick(llm, { place, bible, candidates: images, referenceParts: refs.length ? referenceParts : [], fullPrompt: prompt });
      record[place.id] = [...(record[place.id] ?? []), { round, modelId, projectId, prompt, width, height, verdict }];
      writeJson(join(dir, 'paint.json'), record);
      if (verdict.acceptable || round === 3) {
        chosen = images[Math.min(verdict.best, images.length - 1)];
        if (!verdict.acceptable) say.warn(`${place.id}: kept the best of round 3 though the agent still saw problems: ${verdict.problems}`);
      } else {
        say.dim(`${place.id}: ${verdict.problems}`);
        prompt = verdict.prompt || prompt;
      }
    }
    writeFileSync(file, chosen);
    out.push({ ...place, file });
  }
  return out;
}
