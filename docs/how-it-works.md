# How it works

A world is built in ten steps. Each step is a command, each command writes files
into `worlds/<id>/`, and `node world next` reads those files to tell you (or your
agent) what comes next.

## Contents

- The pipeline at a glance
- A world's folder
- Each step: what it does, which model, which files
- Why it's built this way

## The pipeline at a glance

| # | Command | Model / tool | Writes |
| --- | --- | --- | --- |
| 1 | `new` | — | `world.yaml` from the template, empty folders |
| 2 | `ingest` | sharp | `stills/<place>.jpg`, `stills/index.json`, places in `world.yaml` |
| 3 | *(your agent)* | its own vision | `world.yaml`: story, objects, film directions |
| 4 | `lint` · `quote` | the SDK's cost estimate | nothing: problems and a price |
| 5 | `select` | Segment Anything 3 (`sam3_image_segment_bf16`) | `selections/<place>-<object>.{json,png,preview.jpg}` |
| 6 | `render` | MiniMax H3 FastH3 FLF two-stage (`minimax-h3-fastvideo-int8_flf2v_turbo_2stage`) | `renders/<film>/take-<n>.{json,mp4}` |
| 7 | `screen` · `note` · `reject` | ffmpeg | `take-<n>.screen.json`, `take-<n>.sheet.jpg`, notes |
| 8 | `review` | a local page | `review/verdicts.json` (your decisions) |
| 9 | `narrate` · `music` | Qwen3-TTS · MiniMax Music 3 | `audio/narration/<place>.*`, `audio/music/*` |
| 10 | `build` · `play` · `export` | ffmpeg · Vite | `build/world.json` + finished media · a static site |

## A world's folder

```
worlds/my-trip/
  world.yaml            the plan (the only file written by hand, by your agent)
  photos/               your originals, never modified
  stills/               one canonical still per place, made once
  keyframes/            optional stills pinned inside a film
  voices/               optional recordings for a cloned narrator
  music/                optional music you own
  selections/           outlines of the clickable objects
  renders/<film>/       every take of every film, each with its receipt
  audio/                narration and music takes
  review/               verdicts.json and notes.json
  build/                the finished world: world.json + stills/ + films/ + audio/
```

The plan, verdicts and receipts are small, and git keeps them. Photos, stills,
keyframes, voice recordings, the outline previews (a copy of your photo) and all
rendered media are large and personal, so `.gitignore` leaves them out. Two things
to know before you push a world to a public repository:

- **Receipts name your Sogni account.** Each take's receipt in `renders/` and
  `audio/` records the Sogni username it was rendered under, next to the job id, so
  a render can be traced. Leave `renders/` and `audio/` out too if that matters to you.
- **Your review stays on your machine.** The review page is served on 127.0.0.1
  only, and nothing on it is sent anywhere; only your verdicts are written, to
  `review/verdicts.json`.

## Each step

### 1–2. Stills

`ingest` chooses one **canvas** for the whole world: the H3 shape closest to most
of your photos (3:2 is 1152×768, 16:9 is 1344×768, and so on, up to H3's limit of
1,032,192 pixels). Each photo is then:

1. rotated upright
2. converted from its colour profile to sRGB
3. centre-cropped to the canvas shape
4. resized (Lanczos, never enlarged) to the delivered film size, twice the canvas
5. saved once as JPEG quality 95 with full colour resolution

That file is the place from then on. Masks are traced on it, and every film that
starts or ends there is pinned to it.

### 3. The plan

Your agent looks at each still at full size, interviews you, and writes
`world.yaml`: what's in each picture (`seen`), what to click (`objects`), where each
click leads (`goes`), and a direction for every film. The craft is in
[directing-films.md](directing-films.md) and the format in
[world-yaml.md](world-yaml.md).

### 4. Checks before spending

`lint` checks the plan's structure (ids, destinations, points, frame counts) and
the wording of every film direction against the rules MiniMax's model was trained
on. `quote` prices everything not yet rendered.

### 5. Objects

`select` sends your agent's clicks (positive points on the object, negative points
on its neighbours, an optional box) to Segment Anything 3 on a 1536-pixel copy of
the still. It traces the returned mask into an SVG outline and draws a preview so
the agent can check it grabbed the right thing.

### 6. Films

`render` assembles each film's prompt: MiniMax's alignment line, `[Shot 1]` with
your agent's direction, its sound, and `non_diegetic_music: N/A`. It then sends
the two stills as first and last frame, plus any keyframes, and asks for
first-and-last-frame two-stage at the world's canvas, 24 fps and 4 steps. Before
submitting, it writes a journal that reserves the take. If the connection drops,
running it again finds that journal and follows the same job rather than paying for
a second one. The returned file is checked against its SHA-256 and kept exactly as
delivered.

`--canary` renders just the first crossing and the first loop, so you judge the
quality before paying for the rest.

### 7–8. Judging

`screen` checks each take:

- size, frame count and sound
- whether the first and last frames match the stills
- hard cuts, structure breaks and dissolves (a fast camera move is only a "check"
  note)
- frozen endings on crossings, loops where almost nothing moves, seam flashes and loudness

It also draws a contact sheet. Screening can't read lettering, so your agent looks
at the sheets (every sign, patch, logo and plate included), rejects what is
clearly broken, and notes anything doubtful. Then `review` opens a page where you
watch the remaining takes side by side, with sound, and approve or reject each.
Verdicts are pinned to the file's SHA-256, so a new file never inherits an old
approval.

### 9. Voice and music

`narrate` reads each place's lines in one take:

- a **clone** of a recording you own (Qwen3-TTS voice clone, from 10–30 seconds of
  clean speech and its exact transcript), or
- a **designed** voice.

It then checks the ending wasn't clipped, times every line for subtitles, and
normalises the loudness. `music` generates a score with MiniMax Music 3, or measures and
normalises a file you own.

### 10. Build and share

`build` takes the newest approved take of every film and:

- normalises its sound to −14 LUFS
- encodes a 2K file and an exact half-size copy for phones
- renders a reversed copy of every crossing, so Back plays the journey in reverse
- copies the stills, narration and music
- writes `build/world.json` ([format](world-json.md))

Objects whose film isn't approved yet are left out, and `build` lists them.
`play` opens the world locally. `export` makes a static folder you can put on any
web host ([hosting.md](hosting.md)).

## Why it's built this way

- **A plan file, not a chat log.** Everything that matters is in `world.yaml`, so any
  agent (or you) can pick the world up tomorrow.
- **Journal before paying.** A lost connection mid-submit is the moment duplicate
  bills happen, so every paid job is written down before it is sent.
- **The person decides.** Automatic checks catch the obvious failures. Only a person
  can say a film is good.
- **The player only plays approved files.** `build` writes the world from verdicts,
  so an unreviewed film can't ship by accident.
