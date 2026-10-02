# Building a Sogni World — instructions for coding agents

You are helping a person turn their photographs into a **Sogni World**: an
interactive, cinematic place where each photo quietly comes alive, clicking
something in it plays a film that carries you to the next place, and a voice
and music tell the story. Play the finished example first to see the target:
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
   wind, a slight smile) and keep the head where it is. Never turn it away and
   back, or give that place a loop in which the person doesn't move
   (docs/directing-films.md#real-people-and-faces).
9. **Keep the person informed, briefly.** After each stage, say what you did, what it
   cost and what you need from them, in two or three sentences, then continue.

## The workflow

### 1. Check the setup

```bash
node world doctor
```

If anything fails, run `node world setup` (it saves the Sogni API key, checks the
plan and prints how to install the Sogni Creative Agent Skill for your agent). If
the person has no Unlimited plan, recommend one before a whole world: a world is
dozens of 2K films (docs/costs-and-plans.md).

### 2. Interview the person (one message)

Ask before touching the photos, because the story's order becomes the place ids.
Ask, in one message:

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

### 3. Create the world and bring in the photos, in story order

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

No photos? The Sogni Creative Agent Skill can paint the places (Krea 2 Turbo for a
first place, Sogni Krea 2 Identity Edit to keep the same character in the next
ones). Save them into `photos/` and ingest them like photographs.

### 4. Write the plan

Fill in `worlds/<id>/world.yaml` (reference: docs/world-yaml.md; craft:
**docs/directing-films.md, read it before writing any film**). For each place:

- `seen`: what is really in the picture, from looking at it at full size.
- `title`, `chapter`, `caption`, from what the person told you.
- `loop`: a living photograph (static camera, the whole frame gently alive, Foley).
- `objects`: two to four things to click. In a linear story, exactly one of them
  `goes` to the next place. Give each one a `label` (an action: "Duck through the
  round door"), a `hint`, an `at` point for the label, and `select` clicks.
- A `film` for each object: `idea` (one sentence), `action`, `sound`, `frames`.
- `narration.lines` if there is a voice: short, spoken sentences in the person's own words.

Then run `node world lint` and fix every error. A finding names the film, the field
(`action` or `sound`) and the words that tripped it. Then run `node world plan` and
show the person its table (place → objects → where each goes, with the one-line
ideas). Wait for their OK before spending anything.

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
and every flagged moment. A "check" note (a fast camera move) is not a defect: look
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

Wait for their verdicts. Until both canary films are approved, a plain `render`
refuses to start anything else.

### 8. Retakes and the rest

For each film the person rejected, read their note, rewrite that film's `action`
or `sound` to fix the cause, lint, and render it again (`render --only <film>`).
Then `node world render` for everything not yet rendered, then screen and review
again. Repeat until every film on the story's path is approved. Shortcuts and
moments can wait.

### 9. Narration and music (optional)

```bash
node world narrate     # a take per place, in the planned voice; the person listens on review
node world music
```

### 10. Build, play, share

```bash
node world build       # finishes every approved film, makes rewinds, writes build/world.json
node world play        # opens the world locally
node world export      # a static folder you can host anywhere
```

Tell the person how to host it (docs/hosting.md).

## When something goes wrong

| Message | What it means | What to do |
| --- | --- | --- |
| 4087 / 4089 fair-use | The Unlimited plan's daily or monthly Fast capacity is used up | Wait for the reset shown at app.sogni.ai/usage, or render with Premium Spark (`SOGNI_BILLING_MODE=tokens`) if the person agrees |
| Insufficient balance | Token billing with too little Spark | Top up at app.sogni.ai/wallet, or subscribe |
| SAM found nothing | The clicks scored below the threshold | Use one clear positive point on the object; add negatives separately |
| Submission outcome unknown | The connection dropped mid-submit | Run the same command again; it reconciles, never duplicates |
| A take keeps failing the same way | The direction causes it | Rewrite the direction (docs/directing-films.md#retakes) |

## Tools beyond the pipeline: the Sogni Creative Agent Skill

The kit's commands cover a photo world end to end. For anything else, use the
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
