// Looking and writing: what is in each still (`seen`), then each place's
// title, narration, loop and objects with their films. Every film is checked
// with the same linter `node world lint` runs, inside the model's own retry
// loop, and then reviewed once against the craft rules the linter can't see.
import { join } from 'node:path';
import { clickCauses, lintDirection } from '../lib/lint.js';
import { imagePart, MODELS, studyParts } from '../lib/llm.js';
import { examplePlace, FRAME_GRID, writerSystem } from './prompts.js';

const str = (min, max) => ({ type: 'string', ...(min ? { minLength: min } : {}), ...(max ? { maxLength: max } : {}) });
const strict = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });

// ─── seen ───────────────────────────────────────────────────────────────────

const SEEN_SCHEMA = strict({
  seen: str(200, 1600),
  people: { type: 'array', items: strict({ who: str(3), where: str(3), facing: { type: 'string', enum: ['camera', 'away', 'side', 'small or distant'] } }) },
  clickable: { type: 'array', minItems: 3, maxItems: 10, items: strict({ thing: str(3), where: str(3) }) },
  framing: str(10, 200),
});

/** Describe a still the way the kit asks: at full size, only what is there. */
export async function lookAt(llm, { stillPath, story, about }) {
  const user = [
    { type: 'text', text: [
      'Study this picture closely. You get the whole picture, then its four quarters close up (they overlap a little).',
      about ? `The world is about: ${about}` : null,
      story ? `What the person said about this place: ${story}` : null,
      'Reply with JSON:',
      '- "seen": one dense paragraph (80–200 words) of what is really in the picture, as facts: the framing and viewpoint first ("Wide eye-level shot of …"), then every person (apparent age, hair, clothes, pose, where they are in the frame, where they look), then every notable object with its position (left, centre, right, foreground, background), the light and the weather. Only what you can see; never guess what is outside the frame.',
      '- "people": each person or creature, where they are, and which way they face.',
      '- "clickable": 3 to 10 distinct things a visitor might want to click (a door, a boat, a person, an animal, a lantern, a sign), with where each is.',
      '- "framing": the shot size and camera angle in a few words, exactly as the picture shows it (for example "wide eye-level shot", "low-angle full-length shot", "extreme close-up").',
    ].filter(Boolean).join('\n') },
    ...await studyParts(stillPath),
  ];
  return llm.json({ system: 'You describe photographs and paintings precisely and literally, for a film crew who cannot see them.', user, schema: SEEN_SCHEMA, purpose: 'seen', maxTokens: 4096 });
}

// ─── a place's plan ─────────────────────────────────────────────────────────

const FILM = strict({
  frames: { type: 'integer', enum: FRAME_GRID },
  idea: str(10, 400),
  action: str(150, 4500),
  sound: str(20, 700),
});
const LOOP = strict({ idea: str(10, 300), action: str(150, 3000), sound: str(20, 500) });

function placeSchema({ minObjects, maxObjects }) {
  return strict({
    title: str(2, 60),
    chapter: str(0, 80),
    caption: str(5, 160),
    narration: { type: 'array', maxItems: 4, items: str(2, 220) },
    loop: LOOP,
    objects: {
      type: 'array', minItems: minObjects, maxItems: maxObjects,
      items: strict({
        id: str(2, 24),
        target: str(5, 200),
        label: str(3, 48),
        hint: str(3, 90),
        goes: { type: 'string' },
        shortcut: { type: 'boolean' },
        collect: { type: 'boolean' },
        film: FILM,
      }),
    },
  });
}

/** The routes this place must offer, and the places it may reach. */
export function routesFor(placeId, context) {
  const { order, places, links = [] } = context;
  const index = places.findIndex(p => p.id === placeId);
  const required = links.filter(l => l.from === placeId);
  if (!required.length && order === 'linear') {
    const next = places[index + 1] ?? null;
    if (next && !next.ending) required.push({ from: placeId, to: next.id, why: 'the next place in the story' });
  }
  return required;
}

function placeBrief({ place, index, context, required }) {
  const lines = [];
  const { brief, places } = context;
  lines.push('# The world');
  if (context.title) lines.push(`Title: ${context.title}`);
  lines.push(`About (from the person): ${brief.about}`);
  if (context.story) lines.push(`The story: ${context.story}`);
  if (brief.people) lines.push(`Who is in it (from the person): ${brief.people}`);
  if (brief.others) lines.push(`Everyone else (from the person): ${brief.others}`);
  if (context.style) lines.push(`Visual style of the pictures: ${context.style}`);
  lines.push(`Places, in order: ${places.map(p => `${p.id}${p.ending ? ` (an ending: ${p.ending.kind})` : ''}`).join(', ')}`);
  const narration = brief.narration ?? { voice: 'none' };
  if (narration.voice === 'none') lines.push('Narration: none. Reply with "narration": [].');
  else lines.push(`Narration: 1 to 3 short spoken lines for this place, ${narration.style ?? 'spoken by a narrator who tells the story'}, in plain spoken English, each line under 20 words. Use only facts the person gave or that are visible. ${narration.notes ?? ''}`.trim());

  lines.push('', `# This place: "${place.id}" (place ${index + 1} of ${places.length})`);
  if (place.story) lines.push(`What the person said about it: ${place.story}`);
  if (place.idea) lines.push(`What this place is for: ${place.idea}`);
  lines.push(`Framing of the picture: ${place.framing}`);
  lines.push(`What is in the picture (seen): ${place.seen}`);
  if (place.people?.length) lines.push(`People and creatures: ${place.people.map(p => `${p.who} (${p.where}; facing ${p.facing})`).join('; ')}`);
  lines.push(`Things a visitor might click: ${place.clickable.map(c => `${c.thing} (${c.where})`).join('; ')}`);
  if (place.must?.length) lines.push(`The person asked for these objects here: ${place.must.join('; ')}`);

  lines.push('', '# Where this place\'s objects lead');
  if (place.ending) {
    lines.push(`This place is an ending (${place.ending.kind}: "${place.ending.title}"). Visitors arrive here and the story stops; write its loop and give it no objects ("objects": []).`);
  } else {
    for (const route of required) {
      const to = places.find(p => p.id === route.to);
      lines.push(`- REQUIRED: one object with "goes": "${to.id}"${route.via ? `, and it must be ${route.via}` : ''} (${route.why ?? 'a way on'}). ${to.ending ? `This is a ${to.ending.kind}: the visitor's choice kills them or ends the story ("${to.ending.title}"), so the film shows what happens to them, ending on that picture.` : ''} Its picture is shown below. Its framing: ${to.framing}. Its seen: ${to.seen}`);
    }
    const others = places.filter(p => p.id !== place.id && !required.some(r => r.to === p.id) && !p.ending);
    if (context.order === 'linear' && others.length) lines.push(`- Optional: at most one shortcut ("shortcut": true) to another place in the story: ${others.map(p => `${p.id} ("${p.title ?? p.id}")`).join(', ')}. Only if a clickable thing here really suggests it.`);
    if (context.order === 'linear' && index === places.length - 1 && places.length > 1 && !place.ending) lines.push(`- This is the last place in the story: one object should lead back to the start ("goes": "${places[0].id}") so the journey can begin again.`);
    lines.push('- Every other object is a moment: "goes": "" — a small, surprising event with a clear cause and a payoff, caused by that object (a kea lands on the mirror and tugs its rubber seal; a lantern\'s flame leans toward the visitor), and the picture returns to rest. Never a moment in which someone only breathes, shifts or sways: the loop already does that.');
    if (context.mechanics?.collectibles && place.collectible) lines.push(`- Collectible: one object must be "${place.collectible}", with "collect": true and "goes": "" — finding it adds a figure to the visitor's collection. Its moment film shows it coming to life briefly and returning to rest. Its label names it ("${place.collectible}") and its hint teases it.`);
    else lines.push('- Set "collect": false on every object.');
  }

  lines.push('', '# What to write', [
    'Reply with JSON only:',
    '{ "title", "chapter", "caption", "narration": [lines], "loop": { "idea", "action", "sound" }, "objects": [ { "id", "target", "label", "hint", "goes", "shortcut", "collect", "film": { "frames", "idea", "action", "sound" } } ] }',
    `- ${place.ending ? 'No objects.' : `${required.length > 1 ? required.length : 2} to 4 objects, each a distinct thing really in the picture, each causing its own film.`}`,
    '- "id": a short lower-case id with dashes ("door", "red-lantern").',
    '- "target": the exact thing to click, described so someone could point at it in the picture ("the open red round door behind the couple"). It must be a single object, not a group or a region.',
    '- "label": what happens, as a short action ("Duck through the round door"). "hint": a short tease. "chapter": a short location line.',
    '- "frames": on the grid 124 + 17n. Loops are always 192 (not written: the loop has no frames field). Moments 141–243; a short hop 158–209; a long journey through a boundary 243–362.',
    '- Every "action" starts with the medium and "… begins in the position and framing established by Picture 1: …" (crossings and moments) or "… a static … shot holds the position and framing established by Picture 1: …" (loops), then describes the opening picture using the seen, then the motion in order, then (crossings) the arrival described exactly as the destination\'s seen shows it. Use the real framing words from "Framing" above.',
    '- Loops and moments: a static camera; everything returns to where it started.',
    '- Crossings must pass through a physical boundary the camera moves through when the places are far apart, and each crossing in the world uses a different trick.',
    '- "sound": one to four sentences of ambience and physical sounds. Never music unless the object is about music. Never spoken words.',
    '- Real people\'s faces: in crossings keep them turned away, small or out of focus mid-film; in loops and moments only small motion and the head stays where it is.',
  ].join('\n'));

  const example = examplePlace();
  lines.push('', '# A worked example from a different world (for the quality bar; do not copy its content)',
    `Its seen: ${example.seen}`, `Its next place's seen: ${example.nextSeen}`, `Its answer: ${JSON.stringify(example.answer)}`);
  return lines.join('\n');
}

/** Problems with one place's answer, in words the model can fix. */
export function placeProblems(answer, { place, context, required }) {
  const problems = [];
  const ids = new Set();
  const placeIds = new Set(context.places.map(p => p.id));
  for (const object of answer.objects ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(object.id)) problems.push(`object id "${object.id}" must be lower-case letters, digits and dashes`);
    if (object.id === 'loop') problems.push('"loop" is a reserved id; pick another');
    if (ids.has(object.id)) problems.push(`two objects share the id "${object.id}"`);
    ids.add(object.id);
    if (object.goes && !placeIds.has(object.goes)) problems.push(`object "${object.id}" goes to "${object.goes}", which is not a place (places: ${[...placeIds].join(', ')}; use "" for a moment)`);
    if (object.goes === place.id) problems.push(`object "${object.id}" goes to this same place; use "" for a moment`);
    if (object.collect && object.goes) problems.push(`object "${object.id}" is a collectible, so its "goes" must be ""`);
    const kind = object.goes ? 'crossing' : 'moment';
    const cause = object.film ? clickCauses(object, object.film) : null;
    if (cause) problems.push(`object "${object.id}" film action: ${cause}. Its first motion after the opening description must be ${object.target || object.label} doing what the label promises`);
    for (const f of lintDirection({ ...object.film, kind }, `${object.label} ${object.hint} ${object.film?.idea}`)) {
      if (f.level === 'error') problems.push(`object "${object.id}" film ${f.field}: ${f.message}`);
      else if (['face-turn', 'dark-screen', 'static'].includes(f.rule)) problems.push(`(warning) object "${object.id}" film ${f.field}: ${f.message}`);
    }
  }
  for (const route of required) {
    if (!answer.objects?.some(o => o.goes === route.to)) problems.push(`one object must have "goes": "${route.to}" (${route.why ?? 'required'})`);
  }
  const titleTaken = [context.title, ...context.places.filter(p => p.id !== place.id && p.titleWritten).map(p => p.titleWritten)].filter(Boolean).map(t => t.trim().toLowerCase());
  if (titleTaken.includes(String(answer.title ?? '').trim().toLowerCase())) problems.push(`the title "${answer.title}" is already the world's or another place's title; give this place its own title, named for what is here`);
  const words = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && w !== 'the');
  if (answer.chapter && words(answer.chapter).length && words(answer.chapter).every(w => words(answer.title).includes(w))) problems.push(`the chapter "${answer.chapter}" only repeats the title; make it the where or when (for example "Hobbiton · Matamata" or "Night one"), or leave it ""`);
  if (context.mechanics?.collectibles && place.collectible && !place.ending && !answer.objects?.some(o => o.collect)) problems.push(`one object must be the collectible "${place.collectible}" with "collect": true`);
  for (const f of lintDirection({ ...answer.loop, frames: 192, kind: 'loop' }, answer.loop?.idea ?? '')) {
    if (f.level === 'error') problems.push(`loop ${f.field}: ${f.message}`);
    else if (['face-turn', 'dark-screen'].includes(f.rule)) problems.push(`(warning) loop ${f.field}: ${f.message}`);
  }
  return problems;
}

const REVIEW_SCHEMA = strict({
  clicks: { type: 'array', items: strict({ object: str(1), firstMotion: str(5), startsWithClicked: { type: 'boolean' }, doesWhatLabelSays: { type: 'boolean' } }) },
  checks: { type: 'array', items: strict({ question: { type: 'integer' }, finding: str(2, 400) }) },
  problems: { type: 'array', items: strict({ film: str(2), rule: str(3), fix: str(5) }) },
});

/** The craft rules a linter can't see, checked by the model against its own answer. */
const REVIEW_CHECKLIST = [
  'Does each crossing begin with the clicked object causing the motion (the label and the film agree)?',
  'Does each crossing between far-apart places pass through a physical boundary that fills the view (a doorway, cloud, water, spray, a reflection, a lens) rather than across open air, and is each crossing\'s trick different?',
  'Does each crossing\'s arrival describe the destination exactly as its seen describes it, with the same people in the same places?',
  'Does every action describe the opening picture with its real framing, consistent with the seen (no "medium shot" for a full-length picture)?',
  'Are there props, people or objects that appear mid-film but are not in the start picture?',
  'Do loops keep a static camera with the whole frame gently alive, and does everything return to where it started?',
  'Are real people\'s faces kept turned away, small or out of focus in crossings, and kept still (small motion only) in loops and moments?',
  'Are there notes to the model, mood or genre labels, or anything that cannot be seen or heard?',
  'Is each film\'s length right for what happens (a long journey 243–362 frames, a moment 141–243)?',
  'Does every label describe what really happens in its film and fit what the picture shows (nothing asks to light what is already lit, open what is already open)?',
  'Is every moment a small surprising event with a payoff, caused by its object, rather than someone breathing, shifting or swaying (which the loop already shows)? Are the objects things someone would want to click?',
];

/** Write one place's plan. Returns the checked answer. */
export async function writePlace(llm, { place, index, context, stillPath, destinationStills }) {
  const required = place.ending ? [] : routesFor(place.id, context);
  const minObjects = place.ending ? 0 : Math.max(required.length, 2);
  const maxObjects = place.ending ? 0 : 4;
  const schema = placeSchema({ minObjects, maxObjects });
  const text = placeBrief({ place, index, context, required });
  const user = [
    { type: 'text', text },
    { type: 'text', text: `This place's picture ("${place.id}"):` },
    await imagePart(stillPath),
    ...(await Promise.all(required.map(async route => [
      { type: 'text', text: `The picture of "${route.to}", where the required crossing lands:` },
      await imagePart(destinationStills[route.to]),
    ]))).flat(),
  ];
  const check = answer => placeProblems(answer, { place, context, required });
  const system = writerSystem({ mature: context.mature });
  let answer = await llm.json({ system, user, schema, check, rounds: 4, purpose: `write-${place.id}`, maxTokens: 12000, temperature: 0.7 });

  // One review pass against the rules the linter can't check.
  const review = await llm.json({
    system,
    user: [
      { type: 'text', text: `${text}\n\n# Your answer\n${JSON.stringify(answer)}\n\n# Review it\nFirst, in "clicks", for EVERY object: copy the first sentence of its film that comes after the opening description ("firstMotion"), then say whether that sentence starts with the clicked thing (its target) causing the motion ("startsWithClicked") and whether the film does what the label promises ("doesWhatLabelSays"). A visitor who clicks "Follow the lanterns" must see the lanterns lead; a film that starts with something else feels broken. Then check your answer against each numbered question below, looking at the picture again. In "checks", answer each question in one short sentence (what you found). Then list in "problems" only the real problems, each with the film ("loop" or an object id), the rule it breaks and the concrete fix. A label that contradicts the picture or its film counts. Reply with "problems": [] if there are none.\n${REVIEW_CHECKLIST.map((q, i) => `${i + 1}. ${q}`).join('\n')}` },
      await imagePart(stillPath),
    ],
    schema: REVIEW_SCHEMA,
    purpose: `review-${place.id}`,
    maxTokens: 6000,
    temperature: 0.2,
  });
  // A click the film does not honour is a problem whether or not the model listed it.
  for (const click of review.clicks ?? []) {
    if (click.startsWithClicked && click.doesWhatLabelSays) continue;
    const object = answer.objects.find(o => o.id === click.object);
    if (!object || review.problems.some(p => p.film === click.object && /click|label|cause/i.test(p.rule))) continue;
    review.problems.push({ film: click.object, rule: 'the clicked object causes the film', fix: `Rewrite the film so it opens with ${object.target} doing what "${object.label}" promises (now it opens: "${click.firstMotion}"), or rewrite the label and hint to promise what ${object.target} really does in it` });
  }
  if (review.problems.length) {
    answer = await llm.json({
      system,
      user: [
        { type: 'text', text: `${text}\n\n# Your answer\n${JSON.stringify(answer)}\n\n# Fix these problems found in review, and change nothing else\n${review.problems.map(p => `- ${p.film} (${p.rule}): ${p.fix}`).join('\n')}\n\nReply with the whole corrected JSON object.` },
        await imagePart(stillPath),
        ...(await Promise.all(required.map(async route => [
          { type: 'text', text: `The picture of "${route.to}":` },
          await imagePart(destinationStills[route.to]),
        ]))).flat(),
      ],
      schema,
      check,
      rounds: 4,
      purpose: `revise-${place.id}`,
      maxTokens: 12000,
      temperature: 0.5,
    });
  }
  return { answer, review: review.problems };
}

// ─── the world's own fields ─────────────────────────────────────────────────

const WORLD_SCHEMA = strict({
  title: str(2, 60),
  subtitle: str(2, 120),
  story: str(60, 900),
  narrator: str(0, 300),
  music: str(0, 500),
});

/** Title, subtitle, story, narrator voice and music prompt, from the brief and the places. */
export async function writeWorld(llm, { brief, places, given = {} }) {
  const user = [
    `The person's brief: ${JSON.stringify({ about: brief.about, people: brief.people, others: brief.others, title: brief.title, narration: brief.narration, music: brief.music, concept: brief.paint?.concept })}`,
    `The places, in order: ${places.map(p => `${p.id}: ${p.seen?.slice(0, 300)}`).join('\n')}`,
    'Reply with JSON:',
    `- "title": ${brief.title ? `exactly "${brief.title}"` : 'a short evocative title'}; "subtitle": one line for the title card.`,
    '- "story": one paragraph (at most 900 characters) for the people who will make its films: what the world is, its tone and look, and who is in it. Films carry the visitor between places by moving through something physical in each picture (a doorway, water, a cloud, a lens); say so plainly, and never describe crossings as fades, music or voice-overs.',
    `- "narrator": ${brief.narration?.voice === 'design' ? `a voice description for a text-to-speech voice designer, from the person's request: "${brief.narration.description}". Describe age, gender, accent, tone and pace in one or two sentences.` : '""'}`,
    `- "music": ${brief.music ? `a prompt for a music generator (instruments, tempo, mood, texture, "loops cleanly"), from the person's request: "${brief.music.mood}". No lyrics.` : '""'}`,
  ].join('\n');
  const answer = await llm.json({ system: 'You write the framing text for an interactive cinematic world, faithfully to what its owner asked for.', user, schema: WORLD_SCHEMA, purpose: 'world', maxTokens: 3000 });
  return { ...answer, ...given };
}

export const stillFile = (paths, place) => join(paths.dir, place.still);
