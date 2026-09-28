# Case study: The Long White Cloud

[Play it](https://worlds.sogni.ai/demo/the-long-white-cloud) ·
[its plan](../examples/the-long-white-cloud/world.yaml) ·
[its world.json](../examples/the-long-white-cloud/world.json)

*The Long White Cloud* is a trip through Aotearoa New Zealand in 23 photographs
by Sogni's Mark Ledford, taken with his partner Jen in March and April
2023. It is the world this kit was extracted from. Its plan in `examples/` holds
the real direction behind every film that shipped. The kit's `render` assembles
those directions into exactly the prompts that rendered the live films.

## The brief

> Bring those photos alive in an interactive travel story, full of subtle looping
> photos and wow, and engage with delightful story transitions. Some can be short
> but some can be long, with captivating Foley all the way through.

## The timeline

| When (PT) | What |
| --- | --- |
| Sept 24, ~9:50 PM | The brief |
| overnight | Stills made from the best graded copy of each photo. Every still looked at, all 57 films directed, a canary rendered and checked |
| by 1:10 AM | All 57 films rendered (33 crossings, 23 living photographs, 1 surprise) in 2.5 hours on two Unlimited accounts |
| Sept 25, 5:08 AM | Live, after Mark reviewed overnight: 56 of 57 routes shipped with a take he approved |
| Sept 25–27 | Linear story order, narration in Mark's and Jen's cloned voices, music, retakes, keyframed faces |

## What it's made of

- **23 places**, one per photograph, each a canonical still at 2304×1536 (3:2).
- **23 living photographs**: static camera, the whole frame gently alive, Foley on
  every one.
- **33 crossings**, 6–15 seconds, each caused by something in the photograph: a
  round door, a guitar's sound hole, the painted H on a ferry deck, a helicopter,
  sunglasses, a breath on the lens.
- **Moments**, including a surprise: a kea (the mountain parrot famous for
  stripping the rubber off tourists' cars) lands on the red car's wing mirror.
- **Narration** in Mark's own voice, cloned from a 22.8-second recording with its
  transcript, styled as a phone call. Jen joins at the nine places she is in.
- **A linear story** in the trip's real order, with the out-of-order crossings kept
  as labelled shortcuts.

## What went wrong, and what we changed

Every item here became a rule in [directing-films.md](directing-films.md) or a
check in the kit.

- **The wrong photo.** The first Hobbiton still was picked by filename and turned
  out to be an Instagram edit. Its four films were re-rendered from the right
  photo. *Rule: look at every still before directing it.*
- **Collages.** Two of the trip's source images were split-frame collages, and a
  film can't start or end on a split frame. They were replaced by single photos of
  the same moments.
- **Dissolves.** A crossing that tilted up past one cliff toward another dissolved
  between the two pictures. The one that drove fully into a cloud first crossed
  cleanly. *Rule: pass through a physical boundary; a new seed doesn't help.*
- **Bridges.** A route along a suspension bridge smeared its struts across the lens
  on two takes, even with "the towers passing well out to either side". *Rule and
  lint check: stay clear of lattices.*
- **Invented lettering.** Signs, patches and number plates came back with invented
  text. A retake kept the car side-on so no plate was visible, and got a hat patch
  that reads correctly.
- **Faces.** A mid-film face drifted into a stranger's. *Rule: real faces stay
  turned away until the landing, unless keyframes pin them.* "Say hello" now pins
  Jen's face with two keyframes made from her neighbouring photographs, and holds
  her identity through the whole walk.
- **Framing.** A direction called a full-length photo "a medium shot", and the model
  jumped to a medium framing within two frames. *Rule: describe the photo's real
  framing.*
- **Clipped voices.** The voice model sometimes cut the last word short. *Check: the
  kit's `narrate` looks at the last second of every take for a hard drop to
  silence.*
- **Reference-to-video.** A retake tried reference-to-video with both photographs
  and pinned keyframes. It opened on a stranger and landed on a different face.
  *Rule: first-and-last-frame only.*

## What the example includes

- **`examples/the-long-white-cloud/world.yaml`**: the plan. It has what each
  photograph shows, every object, every crossing, loop and moment with its idea,
  direction and sound, and the SAM clicks. The photographs themselves are not
  included.
- **`examples/the-long-white-cloud/world.json`**: the playable world. It streams the
  approved films, stills and narration from cdn.sogni.ai and worlds.sogni.ai.
  `npm run dev` plays it. The live site's soundtrack is a commercial recording and
  is not part of the example.
