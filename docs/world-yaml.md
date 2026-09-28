# world.yaml reference

`worlds/<id>/world.yaml` is the plan of one world. Your agent writes it, you
approve it, and every `node world` command reads it. `node world lint` checks
it; `node world new <id>` starts one from `templates/world.yaml`.

A worked example with every field in real use is
[`examples/the-long-white-cloud/world.yaml`](../examples/the-long-white-cloud/world.yaml):
the plan behind the live world, whose film directions are the exact text that
rendered each film.

## Contents

- A short complete example
- The world (top-level fields)
- voices and music
- places
- loop (the living photograph)
- objects (what you can click)
- film (the direction for a crossing or moment) — read this before writing one
- Coordinates, frames and canvases
- Recording an exception: `allow`

## A short complete example

```yaml
id: harbour-days
title: Harbour Days
subtitle: A weekend on the coast
story: Two days in a fishing town, told in our own photographs.
order: linear
start: harbour
canvas: 1152x768          # set by `node world ingest`
contentFilter: off

voices:
  narrator:
    clone: voices/me.m4a
    transcript: "Exactly what I say in the recording."

music:
  prompt: "Gentle fingerpicked acoustic guitar and soft strings, warm and unhurried, loops cleanly"
  seconds: 120

places:
  - id: harbour
    photo: photos/IMG_0012.jpg
    still: stills/harbour.jpg
    title: The Harbour
    chapter: "Day 1 · Port Chalmers"
    caption: We got in just after sunrise.
    seen: >
      Wide eye-level shot across a small harbour at dawn: a blue fishing boat
      with a white wheelhouse moored at a wooden jetty in the foreground, gulls
      on the pilings, green hills and pastel houses across still water.
    narration:
      voice: narrator
      lines:
        - "This is where the ferry drops you."
        - "The gulls run the place."
    loop:
      frames: 192
      idea: Gulls shuffle on the pilings, the boat rocks, the water glitters.
      action: >
        Live-action, cinematic, a static wide shot holds the position and framing
        established by Picture 1: the blue fishing boat rocks gently at the jetty,
        two gulls on the pilings shuffle and fluff their feathers, and small
        ripples glitter across the harbour in the low sun.
      sound: >
        Water laps against the hull and the jetty; gulls call and a rope creaks.
    objects:
      - id: boat
        label: Climb aboard
        hint: She leaves on the tide
        at: [0.34, 0.62]
        select:
          positive: [[0.34, 0.62], [0.28, 0.55]]
          negative: [[0.50, 0.70]]
          box: [0.18, 0.40, 0.52, 0.80]
        goes: headland
        film:
          frames: 294
          idea: The boat pulls out and rounds the point to the lighthouse.
          action: >
            Live-action, cinematic, a wide shot begins in the position and
            framing established by Picture 1: the blue fishing boat at the jetty.
            The camera drops onto the stern as the boat pulls away, the harbour
            sliding past, and rides it around the headland until the white
            lighthouse on the rocks fills the view ahead.
          sound: >
            A diesel engine chugs and water churns at the stern; gulls follow,
            calling, and the swell slaps against the hull.

  - id: headland
    photo: photos/IMG_0031.jpg
    still: stills/headland.jpg
    title: The Lighthouse
    seen: >
      A white lighthouse on dark rocks above a rough green sea, grey clouds.
    loop: { frames: 192, action: "...", sound: "..." }
    objects: []
```

## The world

| Field | Meaning |
| --- | --- |
| `id` | Lower-case letters, digits and dashes. Matches the folder name. |
| `title`, `subtitle` | Shown on the title card. |
| `story` | One paragraph: what the world is, its tone, who is in it. Your agent uses it to keep every place and film consistent. |
| `order` | `linear`: a story told in order. The player offers each place's way to the next place first; any other crossing is labelled a shortcut. `free`: every way is equal. |
| `start` | The first place. `ingest` sets it to the first photo if empty. |
| `canvas` | The render canvas every place shares, e.g. `1152x768`. Set by `ingest` from your photos. |
| `contentFilter` | `on` or `off`: Sogni's safe-content filter on generated films. With it on, a withheld film is recorded as a failed take. |

## voices and music

```yaml
voices:
  narrator:
    clone: voices/me.m4a                # 10–30 s of clean speech that you own
    transcript: "Exactly what is said."
  guide:
    design: "A warm, unhurried woman in her forties, close to the microphone."
music:
  prompt: "…"                           # generated on Sogni
  seconds: 120
# or
music:
  file: music/my-song.mp3               # only music you have the rights to
  credit: "Song — Artist"
```

Clone only a voice that is yours or that you have permission to use. A cloned
voice needs the exact transcript of its recording.

## places

One entry per photograph, in story order. `ingest` adds `id`, `photo` and
`still`; everything else is written by your agent after looking at the still.

| Field | Meaning |
| --- | --- |
| `id` | Unique place id. |
| `photo` | Your original, under `photos/`. Never modified. |
| `still` | The canonical still `ingest` made. **Never edit or replace it**: every film that starts or ends here is pinned to its exact pixels. |
| `title`, `chapter`, `caption` | Shown on arrival. |
| `seen` | What is really in the picture, written after viewing it at full size: who, wearing what, where things are. Every direction that starts or ends here is written from it. |
| `narration` | `{ voice, lines }`. Each line is `"text"` (in `voice`) or `{ voice: other, text }` for a second speaker. |
| `loop` | The living photograph (below). |
| `objects` | What you can click (below). |

## loop

The place, gently alive: a **static camera**, the whole frame moving a little
(breath, water, cloud, grass), starting and ending on the still. Its film id is
`<place>-loop`.

```yaml
loop:
  frames: 192                 # 8 s; defaults to 192
  idea: One line for people.
  action: >
    Live-action, cinematic, a static wide shot holds the position and framing established by Picture 1: …
  sound: >
    …
```

## objects

| Field | Meaning |
| --- | --- |
| `id` | Unique within the place. The film id is `<place>-<object>`. |
| `label` | What happens, as an action: "Duck through the round door". |
| `hint` | A short tease under the label. |
| `at` | Where the label sits: `[x, y]` as fractions of the picture. |
| `select` | SAM 3 clicks that outline the object: `positive` points on it, `negative` points on what it touches, an optional `box` `[x0, y0, x1, y1]`, or `text` (e.g. `sheep`) with `instances` for a group. Optional `cleanup: { keepRatio, holeRatio }`. `node world select` draws `selections/<place>-<object>.preview.jpg` so you can check it. |
| `goes` | The place this crossing lands on. **Omit it** for a moment: a film that happens here and returns to this still. |
| `shortcut` | `true` for a crossing that jumps out of the story's order. |
| `film` | The direction (below). |

The object you click must be the thing that carries the film: the door you
duck through, the cloud you fly into, the guitar whose sound hole you enter.

## film

```yaml
film:
  frames: 243                 # 124 + 17n: 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362
  seed: 925250203             # optional: used for take 1 only
  idea: One line for people.
  action: >
    Live-action, cinematic, a wide shot begins in the position and framing established by Picture 1: …
    (what the camera and the picture do, as ONE continuous shot, ending on the next place)
  sound: >
    (ambience, physical sounds, non-verbal human sounds)
  keyframes:                  # optional: extra stills pinned inside the film
    - { image: keyframes/closer.jpg, frame: 48 }
  allow: {}                   # optional: see below
```

You write only `action` and `sound`. The kit wraps them in the exact document
MiniMax H3 expects: the alignment line that pins Picture 1 to the first frame
and Picture 2 to the last, the `integrated_multimodal_description: [Shot 1]`,
`overall_soundscape` and `non_diegetic_music: N/A` fields, and — if your action
does not already land on Picture 2 — the landing sentence. `lint` enforces the
rules that make films hold together; [directing-films.md](directing-films.md)
explains each one. In short:

- Open on Picture 1 ("…begins in / holds the position and framing established by Picture 1: …").
- One continuous shot. Order events with words, never timestamps.
- Only what is seen and heard, as positive facts: no "no", "not", "without".
- No capitals; put visible lettering in "double quotes".
- A crossing passes through something physical — a doorway, a cloud, water, a
  reflection, a fogged lens — never a fade, dissolve or morph.
- Pass bridges and towers far below or far to one side; never fly along them.
- Loops keep a static camera. Moments should too.
- Music only when the film is about music (the label, hint or idea says so).

## Coordinates, frames and canvases

- Points and boxes are fractions of the still's width and height, 0 to 1,
  measured from the top-left.
- Frames are at 24 fps on the H3 grid: 124 (5.17 s) to 362 (15.08 s) in steps
  of 17. A keyframe's `frame` is 1 to frames − 2.
- Canvases (the film arrives at twice each side): 3:2 `1152x768`, 16:9
  `1344x768`, 4:3 `1152x864`, 1:1 `992x992`, 3:4 `864x1152`, 2:3 `768x1152`,
  9:16 `768x1344`.

## Recording an exception: `allow`

Some rules are heuristics. When a take that trips one was approved anyway,
record the rule id and why, so the exception is visible rather than silent:

```yaml
allow:
  lattice: "The camera walks the bridge deck on purpose; take 2 held together and was approved."
```

An allowed finding still prints, as a warning marked "allowed". Rule ids:
`frames`, `length`, `opening`, `one-shot`, `negation`, `capitals`,
`timestamps`, `sound`, `dialogue`, `sentences`, `music`, `transition`,
`materialize`, `lattice`, `dark-screen`, `static`, `keyframes`,
`prompt-length`.
