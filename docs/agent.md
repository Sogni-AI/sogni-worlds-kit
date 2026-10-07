# The built-in agent (no coding agent needed)

`node world agent` builds a world with Sogni's own LLMs doing the work a coding
agent would do. You need the kit, Node, ffmpeg and a Sogni API key. You don't
need Claude Code, Codex or Hermes.

## Contents

- What it does, and what stays yours
- Run it
- The brief (answers in a file)
- Worlds without photographs
- Fatal choices, endings and collectibles
- How it works — read this when a step goes wrong
- Models, speed and cost
- Limits

## What it does, and what stays yours

The agent runs the same pipeline as a coding agent, using the same commands,
checks and craft rules ([directing-films.md](directing-films.md)). Each step is
one bounded task:

| Step | The agent | You |
| --- | --- | --- |
| Interview | asks what only you know: what the world is about, who is in it, each place's story, narration, music | answer |
| Pictures | copies your photos in story order, or paints the places from your concept | approve the concept |
| Look | studies every still whole and in close-up quarters, and writes what is really there | — |
| Plan | writes each place's title, narration, loop and objects with their films, lints every film, then reviews its own work against the rules a linter can't check | approve the plan |
| Point | finds each object, traces it with Segment Anything 3, looks at the traced outline and tries again until it is right | — |
| Render | quotes first, renders, screens every take, rejects clearly broken takes and rewrites their direction | approve the quote |
| Judge | leaves a note on every take it keeps, then opens your review page | **approve or reject every take** there |
| Finish | narration, music, 3D figures, the credit, a build | play it, export it |

The agent never approves a film. It can only reject a take that is clearly broken
(a dissolve, a morph, a hard cut, invented lettering, a face that changes), and it
says why. Everything it keeps waits for you on the review page.

## Run it

```bash
node world setup                 # once: your API key
node world agent my-trip         # asks its questions, then works
```

It asks for anything it needs in the terminal, shows you the plan and the quote,
and waits for your OK before spending. Stop it any time (Ctrl-C); run the same
command again and it picks up where it stopped. `--until plan` stops after the
plan, `--until select` after the outlines, `--until build` before the review page.

It ends by opening your review page (`--review-port`, default 4700; `--no-open`
prints the address instead). Approve the take you want for each film; reject one
with a note saying what is wrong, or pause it, drag a box over the spot and say
what you see there. Press Ctrl-C when you are done, then run the agent again: it
rewrites every film you rejected from your note and the frames you marked,
renders it, and builds with what you approved.

## The brief (answers in a file)

Everything the interview asks can be given up front in a YAML file, which also
lets the agent run unattended:

```yaml
id: my-trip
title: My Trip
about: A weekend on the coast, told in our own photographs.
people: Me (Sam, red raincoat) and my brother Lee (grey beanie).
others: Strangers on the ferry stay small and in the background.
photos:                      # in story order
  - file: ~/Pictures/harbour.jpg
    id: harbour
    story: We got in just after sunrise. The gulls run the place.
  - file: ~/Pictures/ferry.jpg
    id: ferry
    story: The ferry out to the island, wind everywhere.
narration:
  voice: design              # or none
  description: a warm, unhurried woman in her forties
  style: in my first person, like a voice note to a friend
music:
  mood: gentle fingerpicked guitar, salty and bright
approvals:                   # your standing answers, so it can go on without asking
  plan: yes
  spend: yes
  canary: skip               # render everything without judging the canary first
  review: drafts             # build a playable draft before you have judged every take
```

```bash
node world agent my-trip --brief my-trip.yaml
```

`review: drafts` builds the world from the newest take of each film that nobody
rejected, marked **Draft** in the player, so you can play it before you judge
everything. Your verdicts still decide what ships: run `node world review`, then
`node world build` without `--drafts`.

## Worlds without photographs

Give a concept instead of photos, and optionally reference pictures of your
characters:

```yaml
paint:
  concept: >
    My mascot, a small pink sloth (picture attached), wakes at a moonlit crossroads
    below a sleeping stone giant. Three curious things call to him …
  places: 3                  # how many ordinary places (endings are extra)
  canvas: 1344x768
  mature: false              # true for an 18+ world (horror, gore)
  references:
    - file: simon.jpg
      who: Simon, the pink sloth
```

The agent writes a short bible (places, characters, look, and which thing in
each place leads where), paints three candidates per place with Krea 2 (Identity
Edit keeps your character from the reference; 18+ worlds use the Dark Beast
models), looks at them, and keeps the best or repaints with a corrected prompt.
The kept pictures become the world's stills exactly as photographs would.

## Fatal choices, endings and collectibles

```yaml
mechanics:
  endings: true              # some choices kill the visitor; Rewind chooses again
  collectibles: true         # small figures to find and collect
intro:                       # the Begin card's words
  eyebrow: A cinematic horror ride
  tagline: They can take away your fear. You won't like what's left.
  warning: "18+ · Graphic horror, gore, fatal choices and sudden scares."
  begin: Begin the ride
map: false                   # hide the Places panel (no spoilers, no teleporting)
```

An ending is a place with `ending: { kind: death | end, title, text }`. Arriving
there shows its card; **Rewind** plays the fatal film backwards to the choice. A
collectible is an object with `collect: true`: its moment plays, then the visitor
picks up its 3D figure and turns it over, and it joins their collection
("Figures 2/5", kept in their browser), where hidden ones show as silhouettes.
The agent makes the figures with `node world figures`: the object's SAM 3
outline says where it is, BiRefNet cuts it out, Pixal3D builds a GLB of about
60,000 triangles. Run `node world figures <id> --cutouts` to look at the
cut-outs before any mesh is made. Both are ordinary
`world.yaml` fields ([world-yaml.md](world-yaml.md)), so a coding agent can use
them too.

## How it works

The agent is not a chat that improvises. Each step asks Sogni's LLM for one thing
in a fixed JSON shape, checks the answer, and sends any problems back to the
model in plain words until it is right:

- **Every film direction is linted inside the loop** with the same linter as
  `node world lint`, so a direction with a fade, a negation or a dark-screen
  crossing never reaches the plan.
- **A self-review pass** checks what a linter can't: does the clicked object cause
  the film, does a far crossing pass through something physical, does the arrival
  match the destination, does every label fit the picture, is every moment a real
  surprise?
- **Pointing uses a second model.** Qwen 3.6 places boxes and clicks on a picture
  far more accurately than the writer, so it points and the writer checks the
  traced outline.
- **The click is a promise.** The film's first motion must be the clicked thing
  doing what its label says. The linter warns when the first sentences never
  name it, the self-review quotes each film's first motion, the judge rejects a
  take that ignores the click, and a retake may change how it happens but never
  what was clicked. `node world audit-clicks` checks the rendered films the same
  way. A film you reject on the review page is rewritten from your reason
  before it renders again; a rewrite that leaves the words unchanged is refused.
- **Voices stay the same person.** A designed narrator is designed once and that
  recording is cloned for every place.
- **The credit names the models.** The world's About panel says which model
  wrote it, which screened the takes, which found the objects, and which made
  the pictures, films, voices, music and figures, read from the agent's log.
- **Every call is logged** in `worlds/<id>/agent/llm.jsonl` (prompts as text,
  pictures by size) with its time and tokens, and its state is in
  `worlds/<id>/agent/state.json`. Delete a key from the state (for example a
  place under `places`) to make the agent redo that step.

## Models, speed and cost

| Role | Default | Override |
| --- | --- | --- |
| writer and judge | `deepseek-v4-flash-vision-exp-dspark-1m` | `SOGNI_AGENT_MODEL` |
| pointer | `qwen3.6-35b-a3b-gguf-iq4xs` | `SOGNI_AGENT_POINTER_MODEL` |

The LLM work for a three-place world is a few dozen calls and well under a
dollar at pay-as-you-go prices; an Unlimited plan covers it. It is slower than
a frontier coding agent: allow a few minutes per place for the plan when
Sogni's DeepSeek fleet is busy. Films cost exactly what they cost with any agent
([costs-and-plans.md](costs-and-plans.md)).

## Limits

- It writes from what it sees and what you told it, so tell it the story of each
  place; it won't invent names or events.
- It can't hear. Listen to every take yourself on the review page.
- It is more literal than a frontier agent. Expect plainer moments, and read the
  plan before you approve it: `world.yaml` is plain text and yours to edit.
