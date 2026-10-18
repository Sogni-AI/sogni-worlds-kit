# Building a Sogni World — instructions for coding agents

You are helping a person build a **Sogni World** from nothing but a concept, or
from their photographs: an interactive, cinematic place where each picture quietly
comes alive, clicking something in it plays a film that carries you to the next
place, a voice and music tell the story, and a choice can end it (the visitor
rewinds and chooses again). Play the finished example first to see the target:
<https://worlds.sogni.ai/demo/the-long-white-cloud>.

**Your job is the labour. The person is the director.** You plan, write, render,
screen and assemble. They approve the plan, judge the films and decide what ships.

## Ground rules

1. **Loop on `node world next`.** It prints the one thing to do now, with the exact
   command. `node world status` shows the whole picture. Don't improvise a pipeline
   around the CLI; every step you need is a command.
2. **Only the person approves a take.** You can screen, add notes and reject clearly
   broken takes. Approval happens only when they click Approve on `node world review`.
   Never write `review/verdicts.json` yourself.
3. **Say what it costs before spending.** Before the first render, run
   `node world quote` and tell the person the total and how it's paid (their
   Unlimited plan or their token balance). Start with `node world render --canary`
   (one crossing and one loop). A plain `render` refuses to start the rest until the
   person has approved the canary on the review page.
4. **Stills are sacred.** `ingest` makes each canonical still once. Never edit,
   re-save, crop, upscale or replace a still, and never use a video frame or a
   screenshot as one. Every film starts and ends on those exact bytes.
5. **Look before you write.** Open every still at full size (`stills/<place>.jpg`)
   before writing its `seen`, objects or films. If your image input is limited to
   small images, use `.cache/preview/<place>.jpg`. Describe only what is there.
6. **Ask, don't invent.** Names, places, dates, who is in each photo, and what
   happened there are the person's to tell. Ask once, together, then write.
7. **A retake fixes a cause.** When a film is rejected, read the reason, change the
   words that caused it, then render again. Another seed on the same words repeats
   the same failure.
8. **Real people.** Don't give a real person invented dialogue, and never clone a
   voice without its owner's permission. In crossings, keep real faces turned away,
   small or out of focus mid-film, unless they are pinned with keyframes. A loop or
   moment starts *and* ends on the photograph, so a face that is front-on there is
   front-on at both ends: direct only small motion (breathing, a blink, hair in the
   wind, a slight smile) and keep the head where it is; never turn it away and
   back. Or give that place a loop in which the person stays still and the world
   around them moves (docs/directing-films.md#real-people-and-faces).
9. **Keep the person informed, briefly.** After each stage, say what you did, what it
   cost and what you need from them, in two or three sentences, then continue.
10. **Keep their key and their files safe.** Never read or print the Sogni API key:
    the CLI reads it from the environment, `.env` or `~/.config/sogni/credentials`
    itself, and `node world doctor` checks it. If it's missing, have the person run
    `node world setup` in their own terminal: it asks for the key itself, so the key
    never passes through you. Never delete photos, stills, takes, audio or a world
    folder unless the person asks you to, and never run `git clean`,
    `git reset --hard` or a force push in the kit: most of `worlds/` is not in git,
    the photos are personal and every take cost money. Never host, publish or submit
    a world the person hasn't asked you to.

## The workflow

### 1. Check the setup

```bash
node world doctor
```

If anything fails, run `node world setup` (it saves the Sogni API key, checks the
plan and prints how to install the Sogni Creative Agent Skill for your agent; with
no key saved yet, the person runs it in their own terminal, where it asks). If
the person has no Unlimited plan, recommend one before a whole world: a world is
dozens of 2K films (docs/costs-and-plans.md).

### 2. Interview the person (one message)

Ask before touching the photos, because the story's order becomes the place ids.
Ask, in one message:

- Photos or a concept? With photos, the rest of this list. With a concept: what the
  world is and how it looks, who is in it (reference pictures of a character, if
  any), how many places, whether some choices are fatal, and whether there are
  collectibles; then the narration and music questions below, and step 3's
  "No photos?".
- What is this world about, in a sentence? What is its title? (The id is the
  title in short lowercase words, `my-trip`; offer one and let them change it.)
- Who is in the photos? And who else appears (strangers, performers, crew, other
  passengers): should they stay in the films as they are, stay small and in the
  background, or be kept out of the objects and the action?
- In what order should the places come? (Default: the photos' current order, told
  as a linear story.)
- For each place: where is it and what happened there? Anything funny or surprising?
- Narration: none, their own voice (they record 10–30 s of clean speech into
  `voices/` and give you the exact transcript), or a designed voice?
- Music: none, generated (describe the mood), or a track they own the rights to?

### 3. Create the world and bring in the pictures, in story order

```bash
node world new my-trip --title "My Trip"
# the person copies photos into worlds/my-trip/photos/
# rename them in story order: 01-harbour.jpg, 02-ferry.jpg, …
node world ingest my-trip
```

Place ids come from the filenames and can't change later, so rename the photos to
short names in the order from the interview first. The number sets the order and is
dropped from the id (`01-harbour.jpg` becomes the place `harbour`). `ingest` picks
one canvas for the whole world from the photos' shape, writes `stills/<place>.jpg`
and adds a place per photo to `world.yaml`. If a photo would lose more than a
sliver to cropping, it says so: move that photo out, or choose another `--canvas`.

No photos? Paint the places from the concept, then ingest them like photographs:

- The quickest way is the kit's built-in agent: it writes a short bible (places,
  characters, look, what leads where), paints three candidates per place with
  Krea 2 (Identity Edit keeps a character from a reference picture; the Dark Beast
  models for an 18+ world), keeps the best, ingests them and writes a first plan
  for you to take over. Put the concept in a brief (docs/agent.md › The brief, with
  `paint:`) and run `node world agent <id> --brief <file> --until plan`.
- Or paint them yourself with the Sogni Creative Agent Skill: Krea 2 Turbo
  (`sogni-agent -m krea2_turbo_fp8_scaled "…"`) for a first place, Sogni Krea 2
  Identity Edit to keep the same character in the next ones, all at one canvas
  size (1344×768 for 16:9, 1152×768 for 3:2). Save them into `photos/` in story
  order.

Fatal choices and collectibles are plain `world.yaml` fields (`ending`, `collect`,
`intro`; docs/world-yaml.md), whichever way the pictures were made.

### 4. Write the plan

Fill in `worlds/<id>/world.yaml` (reference: docs/world-yaml.md; craft:
**docs/directing-films.md, read it before writing any film**). For each place:

- `seen`: what is really in the picture, from looking at it at full size.
- `title`, `chapter`, `caption`, from what the person told you.
- `loop`: a living photograph (static camera, the whole frame gently alive, Foley).
- `objects`: two to four things to click. In a linear story, exactly one of them
  `goes` to the next place. Give each one a `label` (an action: "Duck through the
  round door"), a `hint`, an `at` point for the label (in open space beside the
  object, never on it), and `select` clicks. Every object must pass the payoff
  question in docs/directing-films.md › Every click pays off: halfway through its
  film, what can the visitor see that the still did not show them?
- A `film` for each object: `idea` (one sentence), `action`, `sound`, `frames`.
- `narration.lines` if there is a voice: short, spoken sentences in the person's own words.

Then run `node world lint` and fix every error. A finding names the film, the field
(`action` or `sound`) and the words that tripped it; a crossing between two stills
of one view is warned about too. Then run `node world plan` and show the person its
table (place → objects → where each goes, with the one-line ideas), and for each
moment the answer to the payoff question. Read the table once as a whole: no beat
(a device switched on, the same kind of encounter, the same trick) may happen
twice in the world. Wait for their OK before spending anything.

### 5. Select the objects

```bash
node world select
```

This runs Segment Anything 3 on your clicks and traces each mask into a clickable
outline. Look at each `selections/<place>-<object>.preview.jpg`, and check coverage.
When an outline grabbed the wrong thing, move or add points (negatives on what it
grabbed) and run `node world select` again: an object whose clicks changed is
outlined again by itself. `select --only <place>-<object>` redoes one outline even
when its clicks didn't change.

### 6. Quote, then render the canary

```bash
node world quote
node world render --canary
```

Tell the person the quote first. A 2K film takes a few minutes to around fifteen
to render. `render` records every take before paying for it and never submits the same
take twice. If it's interrupted, run it again and it resumes. While a render runs,
`node world next` says so (with its pid): wait for it rather than starting another.

### 7. Screen, then ask for a review

```bash
node world screen
```

For every new take, open its contact sheet (`renders/<film>/take-<n>.sheet.jpg`)
and every flagged moment. For a crossing or moment, also open its opening strip
(`take-<n>.opening.jpg`, the first 2.7 s): the clicked thing has to move, or be
moved, first. A "check" note (a fast camera move) is not a defect: look
at it at full size for smearing or a hidden cut. **Screening can't read lettering.**
Look at every sign, patch, logo and number plate on the contact sheet and the
flagged frames yourself: invented or garbled letters are a rejection the numbers
never raise. Reject what is clearly broken, with the reason:

```bash
node world reject my-trip harbour-ferry 1 "dissolves between the two pictures at 4 s"
node world note my-trip harbour-ferry 2 "hands merge briefly at 6.2 s; otherwise clean"
```

The form is `<verb> [world] <film> <take> "text"`: the film id, the take number,
then the words in quotes. The world id can be left out only when `worlds/` holds a
single world (`node world reject harbour-ferry 1 "…"`).

Reject on sight: dissolves or fades, morphs, hard cuts, invented lettering, a real
person's face changing, smeared bridge or tower struts, music nobody asked for, a
frozen tail, and a film that ignores what was clicked (the clicked thing must lead
the film and do what its label says; a retake changes the route, never the cause).
The last one is the fault people find most often by hand, so check it with a
vision model too, and look at every film it calls misaligned or weak:

```bash
node world audit-clicks          # aligned / weak / misaligned, with a one-line fix
```
Then ask the person to review:

```bash
node world review      # prints a local URL; they approve or reject each take
```

On the review page the person can also **mark an area**: pause a take (or tap a
start or end picture), drag a box over what they mean and type a note. Area notes
are saved with the take's time and box, and each gets a picture of the box drawn
on its frame in `review/marks/`.

Wait for their verdicts. Until both canary films are approved, a plain `render`
refuses to start anything else.

### 8. Retakes and the rest

For each film the person rejected, read their note and their area notes
(`node world status` lists both; open each area note's picture in `review/marks/`
before rewriting a direction: the box shows exactly what they mean), rewrite that
film's `action` or `sound` to fix the cause, lint, and render it again (`render --only <film>`).
Then `node world render` for everything not yet rendered, then screen and review
again. Repeat until every film on the story's path is approved. Shortcuts and
moments can wait.

### 9. Narration, music and figures (optional)

```bash
node world narrate     # a take per place, in the planned voice; the person listens on review
node world music       # MiniMax Music 3
node world figures --cutouts   # collectibles only: look at each cut-out, then
node world figures             # build the 3D figures the visitor turns over
```

A designed voice is designed once and cloned for every place, so the narrator
stays one person. Turn every figure over in `node world play` before sharing:
the back and any face are where a figure goes wrong.

### 10. Build, play, share

```bash
node world build       # finishes every approved film, makes rewinds, writes build/world.json
node world play        # opens the world locally
node world export      # a static folder you can host anywhere
```

Tell the person how to host it (docs/hosting.md).

When the person approves the finished world, tell them that independently built
Kit worlds can be listed in Sogni's public community gallery. If they haven't
already chosen whether to submit, ask: "Would you like to submit this world to
Sogni's public community gallery?" Submission is optional. If they agree, help
host the export if needed, then run
`node world submit <id> --url https://their-host.example/ --creator "Their name"`.
Give the person the printed link; they sign in to Sogni, confirm their credit and
sharing permissions, and submit for review. Building a world does not authorize
public submission. Decisions, updates and withdrawal are in My worlds at
worlds.sogni.ai. Before changing a listed world's content, withdraw its listing,
then resubmit the updated version. Hosting stays with the creator.

## When the person hands you the whole build

Sometimes the person gives you an idea and asks for a finished world without
judging anything along the way. The bar stays the same, and you are the first
reviewer: nothing you could have caught should reach them.

1. **Critique the plan before you spend.** Answer the payoff question for every
   object, find any beat used twice, and check every crossing leaves through a way
   out its start picture shows. Then read all the world's words in one pass, in
   story order (captions, labels, hints, narration, ending texts): every name and
   fact stays the same from first mention to last, the mystery or argument can be
   followed, and no line or phrase is said twice. Cut or rewrite what fails. A product, a home or a
   hotel room needs a person in the pictures using things, and no collectibles
   (`figure: true` lets the visitor turn a real object over instead).
2. **Render the canary and judge it yourself** at full size before the rest
   (`render --canary`, then `render --skip-canary`): a fault in how you write
   directions repeats in every film written the same way.
3. **Screen every take and reject on sight**, including a moment where nothing
   happens (`little-happens`) and a room that rearranges itself. Rewrite the
   direction and retake, at most twice per film. A film that still fails is cut,
   and its object goes with it.
4. **Check every outline and figure.** Each selection preview holds the named
   object and only it; each figure's cut-out is the object alone, and you turn
   every built figure over (front, sides, back, top) in the player.
5. **Play the built world as a visitor** at desktop size and at phone size,
   upright and sideways: every label readable and beside its object, every film
   plays and lands, every ending reachable, nothing said twice.
6. **Hand over honestly.** The world stays a draft (`build --drafts`) until the
   person approves its films on `node world review`. Tell them what you rejected
   and why, what you cut, and what you could not fix, and give them the review
   link.

## When something goes wrong

| Message | What it means | What to do |
| --- | --- | --- |
| 4087 / 4089 fair-use | The Unlimited plan's daily or monthly Fast capacity is used up | Wait for the reset shown at app.sogni.ai/usage, or render with Premium Spark (`SOGNI_BILLING_MODE=tokens`) if the person agrees |
| Insufficient balance | Token billing with too little Spark | Top up at app.sogni.ai/wallet, or subscribe |
| SAM found nothing | The clicks scored below the threshold | Use one clear positive point on the object; add negatives separately |
| Submission outcome unknown | The connection dropped mid-submit | Run the same command again; it reconciles, never duplicates |
| A take keeps failing the same way | The direction causes it | Rewrite the direction (docs/directing-films.md#retakes) |
| Sensitive content detected (narration) | The voice model's own check refused the line; a resigned or despairing phrase can trip it | Reword that line in `world.yaml` and run `narrate` again; tell the person what changed |

## Tools beyond the pipeline: the Sogni Creative Agent Skill

The kit's commands cover a world end to end. For anything else, use the
Sogni Creative Agent Skill (`sogni-agent`, installed by `node world setup`). It
uses the same API key and plan. Useful here:

- places from imagination: `sogni-agent -m krea2_turbo_fp8_scaled "…"`
- the same person or character in a new picture, or a keyframe that moves them:
  Sogni Krea 2 Identity Edit (`krea2_identity_edit_sogni_v0_3_alpha`) with context
  images
- a quick single test film, a sound effect, background removal, a 3D collectible

Run `sogni-agent --help`; its own SKILL.md covers these.

## What good looks like

Watch the example world before building, and read
docs/case-study-the-long-white-cloud.md. Every place is quietly alive. Every click
does something caused by the thing you clicked. Every journey passes through a
door, a cloud, a waterfall or a lens instead of dissolving. The sound is rich and
the music sits under it. And a person watched every film that shipped.
