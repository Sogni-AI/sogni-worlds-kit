# world.json: the finished world

`node world build <id>` writes `worlds/<id>/build/world.json` next to the media it
points at, and the player in `player/` reads it. You rarely edit it by hand: change
`world.yaml` (the plan) or your verdicts and build again. This page is for reading
it, debugging it, or writing a converter from another tool.

The formal schema is [`schema/world.schema.json`](../schema/world.schema.json). A
complete real example is [`examples/the-long-white-cloud/world.json`](../examples/the-long-white-cloud/world.json),
which streams every film from Sogni's CDN.

## Paths

Every media field is either a path relative to the `world.json` file
(`films/harbour-ferry.mp4`) or an absolute `https://` URL. The player resolves
relative paths against the URL it loaded `world.json` from, so a built world folder
can be copied to any static host as it is.

## The world

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Always `"sogni-world@1"`. |
| `id` | yes | Lowercase letters, digits and dashes. |
| `title` | yes | Shown on the Begin screen, the top bar and the tab. |
| `subtitle` | | One line under the title on the Begin screen. |
| `credit` | | Who made it and how; shown in the About panel. |
| `aspect` | yes | `{ width, height }` of the stills and films (for a 3:2 world, `2304 × 1536`). Every place is shown at this shape. |
| `start` | yes | The id of the first place. |
| `order` | | Place ids in story order. When present the world is a story told in order: each place offers its next stop first, and the Places panel lists places in this order. `null` or absent for a free-roaming world. |
| `music` | | One track under the whole world, or `null`. See below. |
| `speakers` | | `{ "<name>": { "avatar": "<image>" } }`: a small round picture beside that speaker's subtitles. |
| `places` | yes | The places. See below. |

### `music`

| Field | Meaning |
| --- | --- |
| `src` | An MP3 (or any format browsers play). It loops. |
| `volume` | How loud it sits under the scene; `1` is the default. The visitor's music slider scales it from silence to twice that. |
| `underFilms` | Multiplier while a film or narration plays; default `0.5`. |
| `credit` | Shown in the About panel. Use only music you have the rights to. |

## A place

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique within the world. |
| `title` | yes | The place's name. |
| `chapter` | | Where or when it is, shown before the title ("Day 1 · Wellington"). |
| `caption` | | One line shown for a few seconds on arrival. |
| `still` | yes | The canonical still. Every film that starts or ends here starts or ends on exactly this picture. |
| `loop` | | The living photograph: a film whose first and last frames are the still. It plays over the still with its sound, lap after lap. |
| `narration` | | `{ src?, lines: [{ text, speaker?, start?, end? }] }`. With `src`, each line shows while the audio is between its `start` and `end` (seconds). Without audio, or with sound off, the lines show at reading pace. |
| `hotspots` | yes | The things to click (may be empty). |

The player shows a place with its loop's video frames rather than the JPEG
whenever a loop exists: a JPEG and a video decode to slightly different colours,
and the films start and end on video frames.

## A hotspot

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique within the place (usually the object: `door`, `ferry`). |
| `label` | yes | What happens, as an action: "Duck through the round door". |
| `hint` | | A short tease shown on hover. |
| `at` | yes | `[x, y]`: where the label sits, as fractions (0–1) of the picture's width and height. |
| `outline` | | `{ width, height, path }`: the object's traced outline as an SVG path, drawn in a `width × height` space covering the whole picture. It lights up on hover and is the click target. |
| `to` | | The place this crossing lands on. `null` or absent makes it a *moment*: the film plays and you stay here. |
| `next` | | In a story told in order, this is the way to the next stop (the Next stop button takes it). |
| `shortcut` | | A crossing that jumps out of the story's order, labelled as a shortcut. |
| `film` | yes | The film. See below. |
| `rewind` | | The same film reversed, played by Back after you took this crossing. Without it, Back jumps straight to the previous place. |

### A film

| Field | Required | Meaning |
| --- | --- | --- |
| `src` | yes | The full-size film (the 2K-class two-stage delivery). |
| `src720` | | An exact half-size copy for phones and slow connections (the player's 720p setting). |
| `seconds` | | Its length. Informational. |

A crossing's first frame is its place's still and its last frame is the landing
place's still. The player cuts straight from the film's last frame to the landing
place's loop (the same picture), so there is never a fade.

## Minimal example

```json
{
  "format": "sogni-world@1",
  "id": "harbour-walk",
  "title": "Harbour Walk",
  "aspect": { "width": 2304, "height": 1536 },
  "start": "harbour",
  "order": ["harbour", "beach"],
  "places": [
    {
      "id": "harbour",
      "title": "The Harbour",
      "still": "stills/harbour.jpg",
      "loop": { "src": "films/harbour-loop.mp4", "src720": "films/harbour-loop-720.mp4" },
      "hotspots": [
        {
          "id": "ferry",
          "label": "Board the ferry",
          "at": [0.62, 0.55],
          "outline": { "width": 1536, "height": 1024, "path": "M900 520L1010 505L1030 600L905 610Z" },
          "to": "beach",
          "next": true,
          "film": { "src": "films/harbour-ferry.mp4", "src720": "films/harbour-ferry-720.mp4", "seconds": 10.125 },
          "rewind": { "src": "films/harbour-ferry-rewind.mp4" }
        }
      ]
    },
    {
      "id": "beach",
      "title": "The Beach",
      "still": "stills/beach.jpg",
      "hotspots": []
    }
  ]
}
```

## Playing one

- `npm run dev` plays the example.
- `node world play <id>` plays `worlds/<id>/build/world.json`.
- Any static copy of the player plays `./world.json` beside it, or any world
  given as `?world=<url>` (the host must allow cross-origin reads of that URL).
