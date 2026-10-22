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
import { critiqueStory, STORY_CRAFT } from './story.js';

const str = (min, max) => ({ type: 'string', ...(min ? { minLength: min } : {}), ...(max ? { maxLength: max } : {}) });

const ENDING = { type: 'object', additionalProperties: false, required: ['kind', 'title', 'text'], properties: { kind: { type: 'string', enum: ['none', 'death', 'end'] }, title: str(0, 60), text: str(0, 200) } };

/** The story, written first: the places as beats, before anything about how they look. */
function plotSchema(count) {
  return {
    type: 'object', additionalProperties: false,
    required: ['title', 'subtitle', 'story', 'plot', 'places'],
    properties: {
      title: str(2, 60),
      subtitle: str(2, 140),
      story: str(80, 1200),
      plot: {
        type: 'object', additionalProperties: false, required: ['promise', 'truth', 'cast', 'twists'],
        properties: {
          promise: str(20, 400),
          truth: str(40, 1500),
          cast: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['name', 'who'], properties: { name: str(1, 60), who: str(5, 300) } } },
          twists: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['twist', 'at', 'clues'], properties: { twist: str(10, 300), at: str(2, 24), clues: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['at', 'clue'], properties: { at: str(2, 24), clue: str(10, 300) } } } } } },
        },
      },
      places: {
        type: 'array', minItems: count, maxItems: count + 3,
        items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'beat', 'ending'], properties: { id: str(2, 24), title: str(2, 60), beat: str(10, 400), ending: ENDING } },
      },
    },
  };
}

/** How each place of the plot looks, what can be clicked in it and how the places connect. */
function artSchema(count) {
  return {
    type: 'object', additionalProperties: false,
    required: ['style', 'characters', 'places', 'links'],
    properties: {
      style: str(20, 600),
      characters: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'look', 'reference'], properties: { id: str(2, 24), name: str(1, 40), look: str(20, 600), reference: { type: 'integer', minimum: -1, maximum: 3 } } } },
      places: {
        type: 'array', minItems: count, maxItems: count + 3,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'idea', 'style', 'prompt', 'characters', 'clickables', 'collectible'],
          properties: {
            id: str(2, 24),
            idea: str(10, 500),
            style: str(0, 400),
            prompt: str(150, 2500),
            characters: { type: 'array', items: { type: 'string' } },
            clickables: { type: 'array', minItems: 2, maxItems: 5, items: str(3, 120) },
            collectible: str(0, 80),
          },
        },
      },
      links: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'via', 'to'], properties: { from: str(2), via: str(3, 160), to: str(2) } } },
    },
  };
}

/** The bible the rest of the agent reads: the plot's places, dressed by the art direction. */
export function mergeBible(story, art) {
  return {
    title: story.title, subtitle: story.subtitle, story: story.story,
    plot: { ...story.plot, beats: story.places.filter(p => p.ending.kind === 'none').map(p => ({ place: p.id, beat: p.beat })) },
    style: art.style, characters: art.characters,
    places: story.places.map(p => {
      const look = art.places.find(a => a.id === p.id) ?? { idea: p.beat, style: '', prompt: '', characters: [], clickables: [], collectible: '' };
      return { id: p.id, title: p.title, idea: look.idea, style: look.style, prompt: look.prompt, characters: look.characters, clickables: look.clickables, ending: p.ending, collectible: look.collectible };
    }),
    links: art.links,
  };
}

/** The story's shape: real, unique places, one name per person, endings asked for, every twist planted before it lands. */
export function storyProblems(story, { count, mechanics }) {
  const problems = [];
  const ids = story.places.map(p => p.id);
  const set = new Set(ids);
  if (set.size !== ids.length) problems.push('place ids must be unique');
  for (const id of ids) if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`place id "${id}" must be lower-case letters, digits and dashes`);
  const playable = story.places.filter(p => p.ending.kind === 'none');
  if (playable.length !== count) problems.push(`there must be exactly ${count} places with "ending": {"kind": "none"} (there are ${playable.length}); endings are extra`);
  if (story.places[0]?.ending.kind !== 'none') problems.push('the first place is where the visitor starts; it cannot be an ending');
  if (mechanics?.endings && !story.places.some(p => p.ending.kind === 'death')) problems.push('the person wants fatal choices: at least one place must be a death ending ("kind": "death")');
  if (mechanics?.endings && !story.places.some(p => p.ending.kind === 'end')) problems.push('a story with fatal choices also needs the ending the visitor earns by choosing well ("kind": "end"), reached from the final choice: a choice between deaths is no choice');
  const names = story.plot.cast.map(p => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) problems.push('two people in "cast" share a name; give each person one name of their own');
  const order = playable.map(p => p.id);
  for (const twist of story.plot.twists) {
    if (!set.has(twist.at)) { problems.push(`the twist "${twist.twist}" lands at "${twist.at}", which is not a place`); continue; }
    if (twist.clues.length < 2) problems.push(`the twist "${twist.twist}" needs at least two clues planted before it lands`);
    for (const clue of twist.clues) {
      if (!set.has(clue.at)) problems.push(`a clue for "${twist.twist}" is planted at "${clue.at}", which is not a place`);
      else if (order.includes(twist.at) && order.indexOf(clue.at) >= order.indexOf(twist.at)) problems.push(`the clue "${clue.clue}" is at "${clue.at}", which the visitor does not meet before the twist lands at "${twist.at}"`);
    }
  }
  return problems;
}

export function bibleProblems(bible, { count, mechanics }) {
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
  // The plot's shape, as the story was checked when it was written and as `node world lint` checks it.
  problems.push(...storyProblems({ places: bible.places.map(p => ({ id: p.id, ending: p.ending })), plot: bible.plot }, { count, mechanics: {} }).filter(p => !problems.includes(p)));
  for (const place of playable) if (!bible.plot.beats.some(b => b.place === place.id)) problems.push(`"${place.id}" has no plot beat: every place changes what the visitor knows or wants`);
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const place of bible.places) {
    if (place.collectible && !place.clickables.some(c => same(c, place.collectible))) problems.push(`place "${place.id}": its "collectible" must be copied exactly from its clickables (${JSON.stringify(place.clickables)})`);
    for (const link of bible.links.filter(l => l.from === place.id)) {
      if (!place.clickables.some(c => same(c, link.via))) problems.push(`link ${link.from} → ${link.to}: "via" must be copied exactly from "${place.id}"'s clickables (${JSON.stringify(place.clickables)})`);
    }
  }
  return problems;
}

/**
 * Write the world's bible from the person's concept, in two calls: the story
 * first (its places as beats, with thinking), then how each place looks, what
 * can be clicked and how the places connect. One call for both ran past the
 * LLM's five-minute limit on five places.
 */
export async function writeBible(llm, { brief, referenceParts }) {
  const paintBrief = brief.paint;
  const count = paintBrief.places ?? 3;
  const concept = [
    `Their concept, in their words: ${paintBrief.concept}`,
    brief.about ? `What it is about: ${brief.about}` : null,
    brief.title ? `Its title: ${brief.title}` : null,
    paintBrief.places ? `How many places: ${count} (plus any endings).` : null,
    paintBrief.mature ? 'It is 18+: the person has authorised graphic horror, gore and frightening imagery. Plan it at that intensity.' : null,
  ];
  const storySystem = 'You are the story writer of an interactive cinematic world: a gripping, clever story told across a few places, the way a great film or novel would tell it.';
  const storyUser = [
      'A person wants an interactive cinematic world: a few painted places, each a single picture that quietly comes alive. Clicking a thing in a picture plays a short film that carries the visitor to another place (or reveals something there), and a narrator speaks a few lines at each place. Write its story first; the pictures are planned from it afterwards.',
      ...concept,
      brief.mechanics?.endings ? 'Fatal choices: some clicks kill the visitor. Each death is its own ending place ("ending": {"kind": "death", "title": "You …", "text": "one line"}), reached from the place where the fatal choice is made. The visitor can rewind and choose again.' : null,
      '',
      'Unless the concept is plainly a place to wander with no story, make the story gripping and clever, at the intensity the person asked for. What makes it work:',
      ...STORY_CRAFT.map(rule => `- ${rule}`),
      '',
      'Reply with JSON:',
      '- "title", "subtitle", "story" (one paragraph: what the world is, its tone, who is in it, how the visitor moves through it).',
      '- "plot": "promise" (the genre and what the visitor will feel); "truth" (what really happened, start to finish, which the visitor pieces together); "cast" (each person\'s one name and who they are; these names are used everywhere); "twists" (each {"twist", "at": the place where it lands, "clues": at least two {"at": an earlier place, "clue": something the visitor will see in that picture or hear there}}; a world with no story may have none).',
      '- "places": in the order a visitor meets them, the first is where they start. Each has "id" (lower-case letters and dashes), "title", "beat" (what the visitor learns or what turns there, concretely; no two of the same kind; for an ending, what happened) and "ending" ({"kind": "none", "title": "", "text": ""} unless it is an ending).',
  ].filter(line => line !== null).join('\n');
  const storyCall = { system: storySystem, schema: plotSchema(count), check: answer => storyProblems(answer, { count, mechanics: brief.mechanics }), rounds: 4, maxTokens: 16000 };
  let story = await llm.json({ ...storyCall, user: storyUser, purpose: 'bible-story', think: true });
  // An editor reads the outline before anything is planned around it: what breaks the story is
  // cheap to fix now (a missing ending, a clue that leads nowhere) and costly once it is painted.
  const outline = {
    id: 'outline', title: story.title, subtitle: story.subtitle, order: 'linear',
    plot: { ...story.plot, beats: Object.fromEntries(story.places.filter(p => p.ending.kind === 'none').map(p => [p.id, p.beat])) },
    places: story.places.map(p => ({ id: p.id, title: p.title, ending: p.ending.kind === 'none' ? null : p.ending, objects: [] })),
  };
  const edits = (await critiqueStory(llm, { plan: outline, about: brief.about ?? paintBrief.concept, outline: true, purpose: 'bible-story-edit' })).findings.filter(f => f.severity === 'fix');
  if (edits.length) {
    story = await llm.json({ ...storyCall, purpose: 'bible-story-revise',
      user: [storyUser, '', '# Your story', JSON.stringify(story), '', '# A story editor read it. Fix these, keep everything that works, and reply with the whole corrected JSON:', ...edits.map(f => `- ${f.where}: ${f.problem} Fix: ${f.fix}`)].join('\n') });
  }

  const user = [
    { type: 'text', text: [
      'A person wants an interactive cinematic world: a few painted places, each a single picture that quietly comes alive. Clicking a thing in a picture plays a short film that carries the visitor to another place (or reveals something there). Its story is written; plan how each place looks, what can be clicked in it and how the places connect, so the pictures can tell that story.',
      ...concept.filter(Boolean),
      brief.mechanics?.collectibles ? 'Collectible figures: small characters or objects hidden in places that the visitor can collect by clicking them. Name one per place in "collectible" where it fits (copied exactly from that place\'s clickables).' : null,
      referenceParts.length ? 'The person supplied reference pictures of their character(s), shown below in order (reference 0, 1, …). Use "reference" on a character to say which picture shows them (-1 for none). Describe each character\'s look exactly as the reference shows it.' : null,
      '',
      `The story: ${JSON.stringify(story)}`,
      '',
      'Reply with JSON:',
      '- "style": the visual style every picture shares (medium, palette, lighting, lens or technique), as words to append to an image prompt. If places deliberately differ in style, put each place\'s own style in its "style" and keep this one for what they share.',
      '- "characters": the people of the cast who appear in the pictures, with a precise visual description ("name" exactly as the cast gives it).',
      `- "places": one for each place of the story, with the same "id"s in the same order (${story.places.map(p => p.id).join(', ')}). Each has "id", "idea" (what the place is and what happens here, from its beat), "style" (its own style or ""), "prompt" (a detailed image prompt for this single picture: the composition, viewpoint and framing (a wide shot unless it must be close), where each thing is in the frame, the light; 2–4 distinct clickable things clearly visible and well separated, each a single object, among them every clue the story plants here that can be seen; any character small or mid-sized in the scene, not a portrait; any writing the place needs (a sign, a note, words in lipstick on a mirror) written out and named as what it reads, short words that fit the story, since a picture model spells only the words it is given; captions and logos left out of the picture), "characters" (ids present), "clickables" (the clickable things, as named in the prompt), "collectible" ("" if none).`,
      '- "links": how places connect, each {"from", "via" (the clickable thing in "from" that causes the journey, copied exactly from its clickables), "to"}. Every place except endings has at least one way out (the last ordinary place may lead back to the first); every place can be reached from the first; a death ending is reached from the place where the fatal choice is made.',
    ].filter(line => line !== null).join('\n') },
    ...referenceParts,
  ];
  const art = await llm.json({
    system: 'You are the art director of an interactive cinematic world. You make each place rich, specific and visually striking, with clear clickable things that tell its story.',
    user,
    schema: artSchema(count),
    check: answer => {
      const ids = story.places.map(p => p.id);
      if (answer.places.map(p => p.id).join() !== ids.join()) return [`"places" must be exactly the story's places, in order: ${ids.join(', ')}`];
      return bibleProblems(mergeBible(story, answer), { count, mechanics: brief.mechanics });
    },
    rounds: 4,
    purpose: 'bible-art',
    maxTokens: 16000,
  });
  return mergeBible(story, art);
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
        `Below are ${candidates.length} candidates (candidate 0, 1, …). Pick the best. It is acceptable only if every clickable thing is clearly visible and separate, every character matches, there is no caption, logo or watermark, any writing in the picture (a sign, a note, words on a mirror) is real words, exactly the words the prompt quotes, with none the prompt does not ask for, there are no extra limbs or broken anatomy, and it would make a striking first picture of a film. Read every letter you can see before you answer.`,
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
