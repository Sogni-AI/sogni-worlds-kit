---
name: sogni-worlds
description: Build a Sogni World — an interactive, cinematic, click-through world made from the user's photos or painted from a concept (each place comes alive; clicking an object plays a MiniMax H3 film to the next place; narration, music, fatal choices, endings and 3D collectibles). Use when the user asks to build, plan, render, review or publish a Sogni World, a photo world, an interactive travel story, a choose-your-own-adventure video story or a click-through adventure from photos or from an idea, or mentions worlds.sogni.ai or the Sogni Worlds Kit.
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

2. **Read `AGENTS.md` in the kit and follow it.** It is the complete workflow:
   setup, interview, plan, select, render (canary first), screen, the person's
   review, retakes, narration, music, build, play, export.

3. **Drive with `node world next`.** It prints the one next action and its exact
   command. `node world status` shows everything.

Rules that matter even before you open AGENTS.md:

- Only the person approves films (`node world review`); you may reject broken ones.
- Quote before spending (`node world quote`), and render the canary before the rest.
- Never edit a still or use a video frame as one.
- Look at every picture at full size before writing about it.
- A retake rewrites the direction that caused the defect.

Needs Node 22.12+, ffmpeg and a Sogni API key (`node world setup`). An Unlimited plan
is strongly recommended for a whole world.
