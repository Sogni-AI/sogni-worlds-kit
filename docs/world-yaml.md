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
- plot (the story of a made-up world)
- voices and music
- places
- loop (the living photograph)
- objects (what you can click)
- reveal (a close look the film lands on and holds)
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
| `order` | `linear`: a story told in order. The player offers each place's way to the next place first; any other crossing is labelled a shortcut. The last place needs no onward crossing (its loop and moments are enough; give it an `ending` only if arriving there ends the story). `free`: every way is equal. |
| `start` | The first place. `ingest` sets it to the first photo if empty. |
| `canvas` | The render canvas every place shares, e.g. `1152x768`. Set by `ingest` from your photos. |
| `contentFilter` | `on` or `off` (default `off`: new worlds start with it off): Sogni's safe-content filter on generated films. With it on, a withheld film is recorded as a failed take. |
| `intro` | Optional words for the Begin card: `{ eyebrow, tagline, warning, begin }`. |
| `map` | `false` hides the Places panel (no spoilers, no teleporting). |
| `plot` | A made-up world's story, which visitors never see (below). |

## plot

A world you make up gets its story first (docs/writing-the-story.md). Visitors
never see it; the pictures, films, lines and `node world story` all follow it. A
world of your own photographs leaves it out.

```yaml
plot:
  promise: A film-noir murder mystery in the rain: a client with a secret, a reveal that turns the case over.
  truth: >                    # what really happened, start to finish
    Vera Lane drowned her sister Eleanor on Sunday night, then hired a detective to be seen looking for her.
  cast:                       # one name per person, used everywhere
    - name: Vera Lane
      who: the client in grey; the killer
  beats:                      # every place: what the visitor learns, or what turns there
    office: The hook. Vera hires you to find her sister; her stained glove stays on.
    pier: The turn. The sister's coat comes out of the water with Vera's lighter in it.
  twists:
    - twist: The client is the killer.
      at: pier                # where it lands
      clues:                  # at least two, in places the visitor meets before it
        - { at: office, clue: "Vera's left glove is stained at the palm, and she keeps it on." }
        - { at: club, clue: "The bartender says the sisters fought on Sunday, and Vera was there." }
```

`lint` checks its shape: every place it names exists, no two people share a name,
every place has a beat, every twist has at least two clues, and in a story told in
order every clue comes before its twist. `node world story` checks the rest.

## voices and music

```yaml
voices:
  narrator:
    clone: voices/me.m4a                # 10–30 s of clean speech that you own
    transcript: "Exactly what is said."
  guide:
    design: "A warm, unhurried woman in her forties, close to the microphone."
    label: The guide                    # optional: the name shown with this voice's lines
music:
  prompt: "…"                           # generated on Sogni with MiniMax Music 3: put tempo, key and mood here
  seconds: 120                          # 10–300; a ceiling, it may end on a resolution a little sooner
# or
music:
  file: music/my-song.mp3               # only music you have the rights to
  credit: "Song — Artist"
```

Clone only a voice that is yours or that you have permission to use. A cloned
voice needs the exact transcript of its recording.

A designed voice is made once and then kept: `narrate` designs it on a fixed
15-second passage (`voices/<name>.designed.wav`) and clones that recording for
every place, so the narrator is the same person everywhere. Designing it afresh
for each place would cast a different person each time. Change the `design`
words and the voice is designed again.

Generated music is instrumental and uses MiniMax Music 3, the best music model
on Sogni. It takes tempo, key and metre from the prompt ("84 BPM, D major");
`bpm`, `keyscale` and `timesignature` are folded into the prompt for it. For
exact BPM and key control, or a track longer than 300 s, set
`model: ace_step_1.5_xl_turbo` (or `ace_step_1.5_xl_sft`), the older model.

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
| `narration` | `{ voice, lines }`. Each line is `"text"` (in `voice`) or `{ voice: other, text }` for a second speaker. Lines that change voice are a conversation (a call, an exchange): `narrate` speaks each speaker's lines in their own voice and captions each line with that voice's `label`. |
| `loop` | The living photograph (below). |
| `ending` | Optional: `{ kind: death \| end, title, text }`. Arriving here ends the story; a death offers Rewind to choose again. An ending needs no objects and no loop. |
| `music` | Optional: `{ file, volume, underFilms, credit }`, a track you have the rights to, under this place instead of the world's `music` while the visitor is here (the player fades between them); `null` keeps this place silent. `node world music` generates only the world's track. |
| `objects` | What you can click (below). |

## loop

The place, gently alive: the camera where the still has it, the whole frame
moving a little (breath, water, cloud, grass), starting and ending on the still.
Its film id is `<place>-loop`.

```yaml
loop:
  frames: 192                 # 8 s; defaults to 192
  idea: One line for people.
  action: >
    Live-action, cinematic, a wide shot holds the position and framing established by Picture 1: …
  sound: >
    …
```

The camera is said by the kit, in fixed words, in front of the action: locked, for
every loop and moment (one that has to land where it began and moves pushes in and
back). directing-films.md › Loops says why.

## objects

| Field | Meaning |
| --- | --- |
| `id` | Unique within the place. The film id is `<place>-<object>`. |
| `label` | What happens, as an action: "Duck through the round door". |
| `hint` | A short tease under the label. |
| `at` | Where the label sits: `[x, y]` as fractions of the picture. Put it **beside** the object, in open space just above it, never on it: a label is the size of a small object and hides the very thing it names. (The player moves a label it finds on a small object to just above it, but it cannot know where the open space is.) |
| `select` | SAM 3 clicks that outline the object: `positive` points on it, `negative` points on what it touches, an optional `box` `[x0, y0, x1, y1]`, or `text` (e.g. `sheep`) with `instances` for a group. Optional `cleanup: { keepRatio, holeRatio }`. `node world select` draws `selections/<place>-<object>.preview.jpg` so you can check it. |
| `goes` | The place this crossing lands on. **Omit it** for a moment: a film that happens here and returns to this still. |
| `shortcut` | `true` for a crossing that jumps out of the story's order. |
| `collect` | `true` for a collectible: a moment (no `goes`) that adds this object to the visitor's collection. `node world figures` stands it up in 3D (Pixal3D) so the visitor can turn it over when they find it. |
| `figure` | `false` keeps a collectible flat (no 3D figure); `true` gives any object a figure the visitor turns over after its film, without collecting it. A world that is not a game (a home, a hotel room, a product) uses `figure: true` instead of `collect`. |
| `details` | A card about the object, shown beside its film until the visitor closes it or moves on: `{ title, text, facts: [[label, value], …] }`. For a world that shows something real (a hotel room, a home, a product): what it is, in a sentence or two, and the facts a visitor would ask for. |
| `figureName` | What the figure is called in the collection. Default: the label without its verb ("Touch the neon lotus" → "The neon lotus"). |
| `figureNoun` | The plain noun Pixal3D is told the object is ("telescope"). Default: the head noun of `target` or `label`. |
| `figureLook` | What the 3D figure's plate is drawn as: the object in its full shape, how it looks, with no writing on it ("a lady's light grey kid glove, its palm stained with dried blood"). `node world figures` draws it alone on white from its picture (and its close look) before Pixal3D makes it 3D. Default: `target`. |
| `film` | The direction (below). |
| `reveal` | A close look the film lands on and holds while its line is said or its figure turned over, then a film back (below). Only on an object that stays (no `goes`). |

The object you click must be the thing that carries the film: the door you
duck through, the cloud you fly into, the guitar whose sound hole you enter.
The label is a promise: the film's first motion is that thing doing what the
label says. `lint` warns (`cause`) when the first sentences of the motion never
name it, and `node world audit-clicks` has a vision model compare each rendered
film's opening with its click.

## reveal

A close look: the object's `film` carries the visitor from the place into it; the
world holds there while the narrator says `line` (and a figure, if the object has
one, is turned over); the visitor presses `done`; then the film back returns to the
place. The film back is the film in played backwards (build makes it, with the
place's loop sound under it) unless you write `back`. Its films are
`<place>-<object>` and, when written, `<place>-<object>-back`.

```yaml
objects:
  - id: glove
    label: Turn the glove over
    hint: A down payment, or a signature
    figureLook: a lady's light grey kid glove, its palm stained with dried blood   # the 3D figure's plate (no writing)
    film:                       # the place → the close look (the camera may move in)
      frames: 158
      idea: A hand turns the top glove over on the desk as the camera moves in on the blood and the tag.
      action: >
        Live-action, cinematic film noir, a wide shot begins in the position and framing established by Picture 1: …
        … a small white laundry tag inside its cuff reads "T. HALE".
      sound: >
        …
    reveal:
      paint: >                  # only what changes in the zoomed crop of the place's still
        The top grey glove now lies turned over in the same place, palm up: dried brown-red blood stains its palm,
        and a small white laundry tag inside its cuff reads "T. HALE". Everything else stays as it is.
      zoom: 2                   # optional: how far the close look moves in, 1 to 3 (default: the object fills ~2/5, at most 2x)
      still: reveals/office-glove.jpg   # written by `node world reveals --pick`; never edit the image
      seen: >                   # what is really in the close look, after looking at it at full size
        …
      line: "Grey kid, a lady's size six. The laundry tag says T. Hale. Tuesday's glove, on her sister's hand."
      done: Set the glove down  # the button that ends the close look (default "Continue", or "Put it down" with a figure)
      voice: narrator           # optional: defaults to the place's narration voice
      # back: { frames, idea, action, sound }   # only when the film in cannot run backwards (a pour, a flame, someone walking or speaking)
```

`node world reveals` paints candidates for every reveal with `paint` and no
`still`, each scored for how much of the room it kept; `--pick <place-object> <n>`
keeps one. Then write `seen` and make the film's arrival match it. `node world
narrate` speaks every `line` in the place's voice. Writing in the close look is
named in `paint` and in the film's action as what it reads, with the same words
(directing-films.md › Writing in pictures).

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
  pushIn: { at: [0.72, 0.31], zoom: 2 }   # optional, a crossing only: it starts by moving onto this point
  model: seedance-2-5         # optional: Seedance 2.5 for this film (frames 121 = 5 s); leave it out for H3
  allow: {}                   # optional: see below
```

`pushIn` makes a crossing start with a frame-exact digital push-in from the whole
still onto a crop centred on `at` (`zoom` 1.25 to 3; `frames` 6 to 48, default 18):
the film is rendered from that crop and build puts the push-in in front of it. It is
for a crossing that leaves through a small part of an ordinary picture, and for a map
dive that stays on H3; where Seedance can be used, a dive from a map is one Seedance
film from the whole map instead (directing-films.md › A map, and diving into it).
`model` is `seedance-2-5` or `seedance-2-5-uncensored`, for the shots H3 can't carry:
premium, paid in tokens even on an Unlimited plan, whole seconds
(`frames` = seconds × 24 + 1), no keyframes, and only on a 16:9, 4:3, 1:1, 3:4 or
9:16 canvas (directing-films.md › Seedance 2.5).

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
- No words in ALL CAPITALS (proper nouns are fine); writing the picture shows is named as what it reads: a sign that reads "EXIT".
- Anyone who speaks has their words written in the action, `<d>[English] the words</d>`, one short line per speaker.
- A crossing passes through something physical — a doorway, a cloud, water, a
  reflection, a fogged lens — never a fade, dissolve or morph.
- Pass bridges and towers far below or far to one side; never fly along them.
- Loops and moments keep the locked camera the kit gives them.
- Music only when the film is about music (the label, hint or idea says so).

## Coordinates, frames and canvases

- Points and boxes are fractions of the still's width and height, 0 to 1,
  measured from the top-left.
- Frames are at 24 fps on the H3 grid: 124 (5.17 s) to 362 (15.08 s) in steps
  of 17. A keyframe's `frame` is 1 to frames − 2. A Seedance film is whole
  seconds: 97 (4 s), 121 (5 s), 145 (6 s) … 721 (30 s); its loop defaults to 121.
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
`prompt-length`, `cause`, `unfinished`, `model`.
