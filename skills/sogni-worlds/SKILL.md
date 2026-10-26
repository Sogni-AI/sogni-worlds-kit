---
name: sogni-worlds
description: Build a Sogni World — an interactive, cinematic, click-through world painted from a concept or made from the user's photos (each place comes alive; clicking an object plays a MiniMax H3 film to the next place; narration, music, fatal choices, endings and 3D collectibles). Use when the user asks to build, plan, render, review, publish or submit a Sogni World to the public gallery, a photo world, an interactive travel story, a choose-your-own-adventure video story or a click-through adventure from photos or from an idea, or mentions worlds.sogni.ai or the Sogni Worlds Kit.
metadata:
  version: "0.2.0"
  homepage: https://github.com/Sogni-AI/sogni-worlds-kit
  openclaw:
    emoji: "🌍"
    primaryEnv: "SOGNI_API_KEY"
    os: ["darwin", "linux", "win32"]
    # Only hard requirements: the kit itself is cloned by the first step below,
    # and `node world doctor` says how to install anything else it needs.
    requires:
      bins: ["node", "git"]
      anyBins: ["ffmpeg"]
---

# Sogni Worlds

Everything happens inside the Sogni Worlds Kit, a repository with a command-line
pipeline, a player and the full instructions.

1. **Find or fetch the kit.** If the current folder (or a parent) has `world.js` and
   `AGENTS.md` mentioning "Sogni World", you are in it: run
   `node world update --check` once per session. Otherwise fetch it where the
   person wants their worlds to live:

   ```bash
   git clone https://github.com/Sogni-AI/sogni-worlds-kit
   cd sogni-worlds-kit && npm install
   node world doctor
   ```

   It needs Node 22.12+, git and ffmpeg; `doctor` says how to install what is
   missing. With no Sogni API key yet, the person runs `node world setup` in their
   own terminal: it asks for the key and saves it, so the key never passes
   through you.

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

An Unlimited plan is strongly recommended for a whole world.

When the person approves the finished world, tell them that independently built
Kit worlds can appear in Sogni's public community gallery. If they haven't
already chosen whether to submit, ask: **"Would you like to submit this world to
Sogni's public community gallery?"** Explain that their name is credited, they
keep hosting it, and Sogni reviews it before listing.

If they agree and it is not online yet, suggest Cloudflare Pages on the free plan
(docs/hosting.md › Cloudflare Pages): they make a free Cloudflare account if needed
and sign in once with `npx wrangler@4.129.0 login` (they click Allow; it gives up
after 2 minutes, so start it when they are at the browser); you run
`npx wrangler@4.129.0 pages project create <name> --production-branch main` once, then
`npx wrangler@4.129.0 pages deploy dist/<id> --project-name <name> --branch main`, and use
`https://<name>.pages.dev`. Then run
`node world submit <id> --url <public HTTPS link> --creator "Their name"` (add
`--preview <HTTPS link to an MP4>` for an optional preview loop: docs/hosting.md ›
Preview loop). Give
them the printed, prefilled submission link: they sign in to Sogni, check their
sharing permissions and send it for review. Decisions, resubmission and
withdrawal are in My worlds. If they decline, continue with their chosen sharing
plan; gallery submission is optional. An agreement to build a world alone is not
permission to submit it publicly.

World built outside the Kit? `node world submit --url <link> --creator "Name"`; the gallery review checks it.
