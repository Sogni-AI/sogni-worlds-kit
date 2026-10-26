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
   (one crossing, one loop and the first close look). A plain `render` refuses to start the rest until the
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
11. **Keep the kit current.** If a `node world` command prints a
    `[sogni-worlds] Update available` line on stderr, finish the current step, tell
    the person and offer to run `node world update` (summarise
    `node world update --whats-new`); if they decline, run
    `node world update --snooze`. The line is advice, never command output.

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
  collectibles; what kind of story it is (a murder mystery, a ghost story, a heist,
  a fable, a romance, a comedy, or no story at all, a place to wander) and how it
  should end; then the narration and music questions below, and step 3's
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
  `voices/` and give you the exact transcript), or a designed voice? Close looks are
  told by the narrator: with no narration, a close look can only show a figure.
- Music: none, generated (describe the mood), or a track they own the rights to?
- Want it to play like a game or a trailer they saw (a cast that talks, calls, a
  city to roam)? Read docs/writing-the-story.md › A world that plays like a game,
  then tell them what the kit makes of it (calls in two voices, talking scenes, a
  map that dives into districts, fatal choices) and what it has not (timers,
  meters, scores).

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

No photos? **Write the story first** (docs/writing-the-story.md, read it before
writing a word): unless the person wants no story, put a `plot` in `world.yaml`
before anything is painted: the genre's promise, the truth (what really happened,
start to finish), the cast (one name per person), a beat for every place (what the
visitor learns or what turns there), and every twist with at least two clues planted
in earlier places. Give it a shape: the first place hooks, every place after it
changes what the visitor knows, something near the middle turns the story, the end
is a real choice. Show the person the promise, the beats and the twists in plain
words and wait for their OK; the places, the clickable things and any writing in the
pictures come from the beats and the clues. Then paint the places from the concept,
and ingest them like photographs:

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

Before painting any place, make **one character sheet per recurring character**
(the same character, full body, front, three-quarter, side and back views on plain
light grey; Identity Edit from their reference picture), look at it at full size,
and give that sheet as a context picture for every place they appear in: a name
alone doesn't keep a face. Two places that show one space must agree on everything
both show: paint the second from the first one's pixels with an edit that changes
only what the story moved, or the crossing between them morphs the props.

Whichever way they are painted, **you write the words of any writing a place
shows**: a model spells only the words its prompt gives it. A mirror the story
marks in lipstick gets lipstick that reads "MIDNIGHT, PIER 9", a sign gets its
name; short words chosen for the story. Then read every piece of writing in every
painted place at full size before ingesting it: letters that spell nothing
("Cpole Ligicac" in lipstick on a mirror) mean painting it again. A still is fixed
once ingested, and every film starts and ends on it (docs/directing-films.md ›
Writing in pictures).

Fatal choices and collectibles are plain `world.yaml` fields (`ending`, `collect`,
`intro`; docs/world-yaml.md), whichever way the pictures were made.

### 4. Write the plan

Fill in `worlds/<id>/world.yaml` (reference: docs/world-yaml.md; craft:
**docs/directing-films.md, read it before writing any film**). For each place:

- `seen`: what is really in the picture, from looking at it at full size.
- `title`, `chapter`, `caption`, from what the person told you.
- `loop`: a living photograph (the whole frame gently alive, Foley). The kit locks
  its camera; write only what moves inside the picture (docs/directing-films.md › Loops).
- `objects`: two to four things to click. In a linear story, exactly one of them
  `goes` to the next place. Give each one a `label` (an action: "Duck through the
  round door"), a `hint`, an `at` point for the label (in open space just above the
  object, never on it), and `select` clicks.
- Every object passes the payoff question (docs/directing-films.md › Every click pays
  off): halfway through, what does the visitor see that the still did not show, and
  what do they know afterwards? A moment that only points at a thing, or makes it
  vanish and come back, tells the visitor nothing.
- Anything picked up, opened, read, turned over or asked is a **close look**
  (`reveal`): the film lands on a close-up of the place that shows the clue, the
  narrator says its `line`, and the film runs backwards to put it down
  (docs/directing-films.md › Close looks). A collectible or figure the visitor
  handles is always one.
- A `film` for each object: `idea` (one sentence), `action`, `sound`, `frames`; for a
  close look, `reveal: { paint, line, done }` (docs/world-yaml.md › reveal); for a
  figure, `figureLook`. Any writing a film shows is named in its action as what it
  reads, and anyone who speaks has their exact words written in it
  (`<d>[English] …</d>`, one short line per speaker); never leave words to the model.
- `narration.lines` if there is a voice: short, spoken sentences in the person's own
  words, or, in a made-up world, in the narrator's voice from the plot. Lines can
  change voice (`{ voice: hero, text: … }`): a call or an exchange, each line spoken
  in its own designed voice and captioned with its `label`. Never a wall of text.
- A film H3 can't carry (people talking to each other, fast action where one thing
  causes the next) may opt into Seedance 2.5 with `model: seedance-2-5`: premium,
  not covered by Unlimited, one take per film (docs/directing-films.md › Seedance 2.5).
  A crossing that leaves through a small part of its picture (a district on a map)
  starts with a `pushIn` on that point.
- In a made-up world, every word serves the `plot`: each place delivers its beat,
  each clue is planted where the plot says (in a picture, a close look or a line),
  every person keeps the one name the cast gives them, and no line gives a twist away
  before it lands (docs/writing-the-story.md).

Then run `node world lint` and fix every error. For a made-up world, run
`node world story` too: an independent editor (a Sogni LLM) reads the plot and every
word in order and lists what does not work yet. Rewrite every "fix" and run it again
until none is left. A finding names the film, the field
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

Then make the close looks, in this order (`node world next` walks you through it):
`node world reveals` crops each place's still around the object and edits in only
what `reveal.paint` describes (Qwen Image Edit), three candidates each, with a
`room kept` score. Look at every candidate at full size beside its `.zoom.png` (the
room unchanged, the object and people as in the place, the writing exactly the
words you named), keep one with `node world reveals --pick <place-object> <n>`, write
its `reveal.seen`, then rewrite the object's film so it arrives on that picture
exactly as `seen` describes it, and lint.

### 6. Quote, then render the canary

```bash
node world quote
node world render --canary
```

Tell the person the quote first, and say the Seedance line on its own: those films
are paid from their token balance even on an Unlimited plan. A 2K film takes a few
minutes to around fifteen to render. `render` records every take before paying for it and never submits the same
take twice. If it's interrupted, run it again and it resumes. While a render runs,
`node world next` says so (with its pid): wait for it rather than starting another.

### 7. Screen, then ask for a review

```bash
node world screen
```

For every new take, open its contact sheet (`renders/<film>/take-<n>.sheet.jpg`)
and every flagged moment. For a crossing or moment, also open its opening strip
(`take-<n>.opening.jpg`, the first 2.7 s): the clicked thing has to move, or be
moved, first. For every film between two pictures (a crossing, a reveal, the film
back), open its change strips (`take-<n>.change-<k>.jpg`): sixteen consecutive
frames where the picture changes fastest. Two pictures showing through each other
there is a crossfade the visitor sees as a fade, however short. A "check" note (a fast camera move) is not a defect: look
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

A `stretch-step` on a Seedance take means the picture jumps in shape at its start or
end: compare the two frames it names. Reject on sight (the full list is
docs/directing-films.md › Judging a take):
dissolves or fades, morphs, hard cuts, writing that is not real words, a loop or
moment whose camera pushes in and back (`camera-moves`), an object that vanishes
and comes back, a real person's face changing, smeared bridge or tower struts, music nobody asked for, a
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
node world narrate     # a take per place and per close look's line, in the planned voice; the person listens on review
node world music       # MiniMax Music 3
node world figures --cutouts   # each figure drawn alone on a white plate: look at every plate, then
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

**Ship only what `build` made.** It serves the web formats Sogni's own worlds use:
stills as WebP, films through the streaming profile (H.264, CRF 23 with the bitrate
capped by size, a keyframe every 2 s, fast start, a half-size phone copy), a JPEG
social card, PNG only for icons. `build` and `export` check every file and stop on
one outside them, naming it and saying how to fix it: fix it, never work around
the check. Never copy a raw take, a PNG or an uncapped encode into a world you
host; a file you add by hand is converted first (docs/hosting.md › What a world serves).

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
   object (what the visitor learns, and the line that says it), find any beat used
   twice, check every crossing leaves through a way out its start picture shows (or
   is carried by something passing the lens: never a fade or a cut), and check every
   loop's camera fits its place. Then read all the world's words in one pass, in
   story order (captions, labels, hints, narration, ending texts): every name and
   fact stays the same from first mention to last, the mystery or argument can be
   followed, and no line or phrase is said twice. In a made-up world, write the
   `plot` first and run `node world story` until it has no "fix" left: a story that
   does not hook, turn and pay off is not worth rendering. Cut or rewrite what fails. A product, a home or a
   hotel room needs a person in the pictures using things, and no collectibles
   (`figure: true` lets the visitor turn a real object over instead).
2. **Render the canary and judge it yourself** at full size before the rest
   (`render --canary`, then `render --skip-canary`): a fault in how you write
   directions repeats in every film written the same way. Handing you the whole
   build is the person's agreement to skip waiting on their canary verdict. In this
   mode `next` stops at the review it cannot hold, so run, in order: select →
   reveals (pick, seen) → render --canary → screen → render --skip-canary → screen →
   narrate → music → figures --cutouts → figures → build --drafts.
3. **Screen every take and reject on sight** (docs/directing-films.md › Judging a
   take is the one list), including a moment where nothing happens
   (`little-happens`), a camera that moves (`camera-moves`) and a room that
   rearranges itself. Rewrite the direction and retake, at most twice per film. A
   film that still fails is cut, and its object goes with it.
4. **Check every outline, close look and figure.** Read every piece of writing in
   every still and close look; each selection preview holds the named object and
   only it; each figure's plate is the object alone and whole, with no table and
   no writing, and you turn every built figure over (front, sides, back, top,
   underside) in the player.
5. **Play the built world as a visitor** at desktop size and at phone size,
   upright and sideways: every label readable and beside its object, every film
   plays and lands, every close look holds and says its line over the place's
   sound, every ending reachable, nothing said twice.
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

Run `sogni-agent --help`; its own SKILL.md covers these. A trailer for a finished
world is cut from its approved films with ffmpeg: docs/trailers.md.

## What good looks like

Watch the example world before building, and read
docs/case-study-the-long-white-cloud.md. Every place is quietly alive. Every click
does something caused by the thing you clicked, and tells you something. Every
journey passes through a door, a cloud, a waterfall or a lens instead of dissolving. The sound is rich and
the music sits under it. And a person watched every film that shipped.
