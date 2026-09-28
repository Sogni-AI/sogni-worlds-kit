# Directing films

This is the craft. The code only does what these rules describe. Every rule
below cost at least one rejected film to learn, most of them while we built the
three official worlds on [worlds.sogni.ai](https://worlds.sogni.ai).

## Contents

- The three kinds of film — read first
- The recipe (why first-and-last-frame, why two-stage)
- Writing a direction — the `action` field, with a real example
- Writing sound — the `sound` field
- Crossings: how to get from one picture to another
- Loops: living photographs
- Moments and surprises
- Real people and faces
- Choosing objects and clicks
- Lengths
- Judging a take — what to reject on sight
- Retakes
- What the linter checks

## The three kinds of film

| Kind | Starts on | Ends on | Camera | What it is |
| --- | --- | --- | --- | --- |
| **loop** | this place's still | the same still | static | The photograph comes alive: water moves, people breathe and shift. Plays whenever you are here. |
| **crossing** | this place's still | the next place's still | moves | A journey caused by something in the picture: a door, a boat, a guitar, a breath on the lens. |
| **moment** | this place's still | the same still | mostly static | Something happens here (a parrot lands on the car mirror) and the scene returns to rest. |

A place has one loop, and two to four objects. Each object either **goes**
somewhere (a crossing) or makes a **moment**.

## The recipe

Every film uses one model and one mode: **MiniMax H3, FastH3 first-and-last-frame,
two-stage** (`minimax-h3-fastvideo-int8_flf2v_turbo_2stage`). The kit sets this
for you, and there is no switch for it, on purpose.

- **First-and-last-frame (FLF)** pins frame 0 to the start picture and the final
  frame to the end picture. It is the only mode that guarantees a crossing starts
  exactly where you are and lands exactly where you arrive, so there is no jump
  when the film hands over to the next place. Reference-to-video modes treat
  pictures as suggestions. With two photographs as references plus pinned keyframes,
  they still opened on a stranger and landed on a different face.
- **Two-stage** renders a canvas (1152×768 for 3:2 photos) and delivers twice its
  width and height (2304×1536) in the same pass. That gives native 2K detail
  rather than an upscale afterwards.
- **One continuous shot.** First-and-last-frame interpolates a single path. A cut
  inside the film breaks that path, and the last frame then has to be reached
  from nowhere.

## Writing a direction (`action`)

Your agent writes two fields per film: `action` (what we see) and `sound` (what
we hear). The kit wraps them in the exact document MiniMax's model was trained
on: the alignment line, `[Shot 1]`, the landing sentence and
`non_diegetic_music: N/A`. Don't write those parts yourself.

The shape of every `action`:

1. **The medium and the opening frame, as facts.** Start with the style as you can
   see it, then tie it to the first picture, then say what is in that picture:
   `Live-action, cinematic, a wide eye-level shot begins in the position and framing established by Picture 1: …`
   For illustrated worlds, name the medium you can see instead (for example
   "Hand-painted animation, …").
2. **The path.** Describe what physically happens, in order, in plain words: who
   moves, what the camera does, and what it passes through.
3. **The arrival.** Describe the destination the way its still actually shows it:
   who is where, doing what, from which viewpoint. The kit then adds "The camera
   settles into the pose, spacing and composition established by Picture 2 at the
   end of the shot."

A real crossing from The Long White Cloud ("Into the sound hole", 294 frames):

> Live-action, cinematic, a low wide shot begins in the position and framing
> established by Picture 1: the curly-haired guitarist strums at the front of the
> dark carved stage, singers kneeling and standing behind him with sticks raised.
> He leans the guitar toward the camera as he strums, and the camera pushes in
> toward its round sound hole; the strings shiver across the frame and the dark
> mouth of the guitar fills the view. In the darkness a grey doorway of daylight
> grows ahead, and the camera glides out of a ship's cabin onto an open stern deck
> under a grey sky: a pale blue deck painted with a yellow circle and a yellow
> letter H, a white railing, and two people standing apart at the rail looking out
> at a misty fjord …

Rules that keep the model on your side:

- **Look before you write.** Open each still at full size before describing it.
  Write its contents into the place's `seen` field and write every direction
  against that. Never describe what you assume is there.
- **Describe the photograph's real framing.** If the photo is a full-length shot,
  don't call it "a medium shot": the model will jump to your words in two frames.
- **Only what can be seen or heard.** No notes to the model ("preserve anatomy",
  "no morphing", "keep it realistic"), no genre or mood labels ("a horror shot"),
  no capitals, no clock times inside the shot.
- **Positive facts only.** Write "her face stays turned toward the ice", not "we
  never see her face". Naming a thing, even to forbid it, puts it in the film.
- **Don't add what the pictures lack.** An object that must be used in the film has
  to be in the start picture already. A prop that appears mid-film to hide the
  change of place reads as a trick.
- **Plain camera words.** Push in, pull out, pan, tilt, truck, pedestal (rise or
  sink), crane, tracking shot, static shot, POV, with "slowly" or "fast" only when
  it matters.

## Writing sound (`sound`)

One to four sentences of what is actually heard: ambience, physical sounds and
non-verbal human sounds. Sound is generated with the picture, so good Foley makes
a world.

- Describe sounds as events: "sheep bleat across the valley", "the ferry horn
  sounds twice", "crampons crunch on frozen snow".
- **No music**, unless music is the point of the idea (a guitarist playing, a
  jukebox). Asking for "a gentle score" gets you an orchestra over everything, and
  the world's own music then clashes with it. Keep music in `music:`.
- **No spoken words.** A described voice is a stranger's voice. For real people,
  add words with narration in a cloned voice you have permission to use.

## Crossings

A crossing has to feel like you moved, never like one picture turned into
another.

- **Pass through a physical boundary.** When the next place is far away (another
  town, another country, another world), make the jump where the camera passes
  through something that fills the view for a moment: a doorway, a cloud, a water
  surface, a waterfall's spray, a reflection in sunglasses, the dark sound hole of
  a guitar, a fogged lens wiped clean. Across open air the model blends the two
  pictures instead: a dissolve.
- **Never a fade, a dissolve or a morph.** A dark screen isn't a boundary either:
  "darkness fills the view" becomes a fade to black. Keep the occluding surface and
  its moving edge visible.
- **The clicked object causes it.** "Duck through the round door" must start with
  the door. If the label and the film disagree, fix one of them.
- **Stay clear of lattices.** Routes onto, along or through bridges, towers, pylons
  or anything made of struts smear into grey bands. Pass them far below, far off to
  one side, or go around them.
- **Geography first.** Show how you get there: through the door, over the ridge,
  down through the cloud. Spectacle doesn't replace a route.
- **Give it personality.** Aim for "quirky and fun, or super cool, or cheeky", not
  "the camera walks forward". Build a small setup, escalation and payoff around the
  object. Make sure two crossings in one world don't use the same trick.

## Loops

A loop is the photograph breathing. It plays whenever the visitor is at that place.

- **Static camera.** Write "a static wide shot holds the position and framing
  established by Picture 1". The camera doesn't move; the world inside the picture
  does.
- **The whole frame is alive**, not one waterfall. Grass combs in the wind, cloud
  shadows slide, people shift their weight, water moves. Too subtle reads as broken.
- **Everything returns to where it started.** The same still is at both ends, so any
  moved prop or person must be back in place by the end.
- **Foley on every loop.** 192 frames (8 s) is the standard length.

## Moments and surprises

A moment is a small event caused by an object: the kea that lands on the red car's
wing mirror, admires itself, and yanks the rubber seal. The same still is at both
ends and the camera stays mostly static.

Plan a few surprises per world, and cause each one with something really in the
picture. Keep them rare enough to stay surprising.

## Real people and faces

The model can't guarantee a real person's face stays theirs in the middle of a
film. So in films:

- keep a real person's face turned away, small in the frame, behind hands or a hat,
  or out of focus until the landing frames, where the pinned photograph takes over;
- or pin their face with **keyframes**: extra stills placed inside the film at a
  frame you choose (`film.keyframes: [{ image: keyframes/x.jpg, frame: 48 }]`), made
  with an identity-preserving edit of their own neighbouring photographs. The Sogni
  Creative Agent Skill makes these with Sogni Krea 2 Identity Edit. A keyframe's
  face *is* the film's face at that moment, so check it at full size;
- describe people as they appear ("a 35-year-old woman with a round face and a black
  bob, in a navy jacket") so a mid-film glimpse stays close;
- treat cultural performances with dignity: show them as performed, with no comic
  business and no invented words in someone else's language.

## Choosing objects and clicks

- Two to four objects per place. In a linear story, one of them is the way to the
  next stop and the others are moments or shortcuts.
- **Click, don't describe.** `select.positive` points go on the object, and
  `select.negative` points go on what it keeps grabbing (the wall behind a door,
  the person next to the one you want). Ask for "the lantern" in words and you get
  every lantern as one blob.
- Choose objects someone would want to click: a door, a boat, a person, an animal,
  a light. Scenery the size of half the frame makes a poor button.
- Check the traced outline: `select` reports coverage. Above 60% of the frame the
  outline is too greedy; below 0.2% it's too small to find.

## Lengths

Frames sit on H3's grid, 124 + 17n: **124** (5.2 s) up to **362** (15.1 s).

| Film | Frames |
| --- | --- |
| Loop | 192 (8 s) |
| Moment | 141–243 |
| Short hop (same area) | 158–209 |
| Long journey (a boundary to pass) | 243–362 |

Too short for the distance and the model rushes. Too long for a simple action and
it adds business you didn't ask for.

## Judging a take

`node world screen` flags likely problems automatically. Your agent should then
look at the contact sheet and at each flagged moment at full size. **Reject on
sight** (`node world reject <film> <take> "reason"`):

- a dissolve or crossfade between the two pictures, or a fade through black;
- a morph (a wall that becomes a sky, a person who becomes another person);
- a hard cut or a sudden jump in the middle;
- invented lettering on signs, patches or number plates;
- a real person's face drifting into someone else's;
- smeared struts from a bridge or tower route;
- music in the soundtrack when none was asked for;
- a frozen tail (the last seconds don't move) or a flash at a loop's seam.

Everything else goes to the person on `node world review`. Only a person approves
a take.

## Retakes

A rejected film needs a **rewritten direction that fixes the observed cause**, not
another seed. For example: the dissolve came from a camera tilt that asked to see
two different cliffs, so the route now drives fully into the cloud first; the car
showed an invented number plate, so the camera now stays side-on. Write down why
the take failed, change the words that caused it, then render again.

## What the linter checks

`node world lint` refuses a plan with:

- a direction missing the Picture 1 opening;
- more than one shot, clock times inside the shot, or words in capitals;
- negations ("no", "never", "without");
- music words (unless the idea is about music);
- fade, dissolve or morph words, props that "materialize", or darkness that "fills
  the view";
- lower-case sentence starts, or a direction too short to carry motion;
- a route through a bridge or tower;
- a loop or moment that isn't a static shot;
- frames off the 124 + 17n grid, or a prompt over 7,000 characters.

The linter catches words. It can't see the film, so the review still decides.
