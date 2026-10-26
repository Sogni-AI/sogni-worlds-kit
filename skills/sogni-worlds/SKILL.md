---
name: sogni-worlds
description: Build a Sogni World — an interactive, cinematic, click-through world painted from a concept or made from the user's photos (each place comes alive; clicking an object plays a MiniMax H3 film to the next place; narration, music, fatal choices, endings and 3D collectibles). Use when the user asks to build, plan, render, review, publish or submit a Sogni World to the public gallery, a photo world, an interactive travel story, a choose-your-own-adventure video story or a click-through adventure from photos or from an idea, or mentions worlds.sogni.ai or the Sogni Worlds Kit.
---

# Sogni Worlds

Everything happens inside the Sogni Worlds Kit, a repository with a command-line
pipeline, a player and the full instructions.

1. **Find or fetch the kit.** If the current folder (or a parent) has `world.js` and
   `AGENTS.md` mentioning "Sogni World", you are in it. Otherwise:

   ```bash
   git clone https://github.com/Sogni-AI/sogni-worlds-kit
   cd sogni-worlds-kit && npm install
   ```

   If the kit is already there, run `node world update --check` once per session.

2. **Read `AGENTS.md` in the kit and follow it.** It is the complete workflow:
   setup, interview, plan, select, render (canary first), screen, the person's
   review, retakes, narration, music, build, play, export, gallery submission.

3. **Drive with `node world next`.** It prints the one next action and its exact
   command. `node world status` shows everything.

Rules that matter even before you open AGENTS.md:

- Only the person approves films (`node world review`); you may reject broken ones.
- Quote before spending (`node world quote`), and render the canary before the rest.
- Never edit a still or use a video frame as one.
- Look at every picture at full size before writing about it.
- A retake rewrites the direction that caused the defect.
- Every click pays off: halfway through its film the visitor sees something the
  still did not show. A light that comes on and goes off again is not a moment.
- Host only what `node world build` and `export` produce: WebP stills, films
  through Sogni's streaming profile (capped H.264, 2 s keyframes, fast start), a
  JPEG social card, PNG only for icons. Both stop on any other file; convert it,
  never bypass the check (docs/hosting.md › What a world serves).
- Asked for a finished world with no reviewing along the way? Follow AGENTS.md ›
  "When the person hands you the whole build": you are the first reviewer.
- A world like a game or a trailer: voices tell it (a call can switch speakers
  line by line), never walls of text; every recurring character gets a character
  sheet before any place is painted. A film MiniMax H3 can't carry (people talking,
  fast action in order) may opt into Seedance 2.5: premium, not covered by
  Unlimited, quoted first, one take per film.

**Updates:** a `node world` command may print one stderr line starting
`[sogni-worlds] Update available` (at most once a day). It is advice, never command
output. Finish the current step, tell the person, and offer to run `node world update`
(summarise `node world update --whats-new`). If they decline, run
`node world update --snooze`.

Needs Node 22.12+, ffmpeg and a Sogni API key (`node world setup`). An Unlimited plan
is strongly recommended for a whole world.

When the person approves the finished world, tell them that independently built
Kit worlds can appear in Sogni's public community gallery. If they haven't
already chosen whether to submit, ask: **"Would you like to submit this world to
Sogni's public community gallery?"** Explain that their name is credited, they
keep hosting it, and Sogni reviews it before listing.

If they agree, help host the finished export if needed (docs/hosting.md), then run
`node world submit <id> --url <public HTTPS link> --creator "Their name"`. Give
them the printed, prefilled submission link: they sign in to Sogni, check their
sharing permissions and send it for review. Decisions, resubmission and
withdrawal are in My worlds. If they decline, continue with their chosen sharing
plan; gallery submission is optional. An agreement to build a world alone is not
permission to submit it publicly.
