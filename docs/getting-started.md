# Getting started

From nothing to your first rendered film in about fifteen minutes, most of it
waiting for the render.

## 1. Install the tools

| | macOS | Windows | Linux (Debian/Ubuntu) |
| --- | --- | --- | --- |
| Node 20+ | `brew install node` | `winget install OpenJS.NodeJS.LTS` | [nodejs.org](https://nodejs.org) or `nvm install --lts` |
| ffmpeg | `brew install ffmpeg` | `winget install Gyan.FFmpeg` | `sudo apt install ffmpeg` |
| git | included with Xcode tools | `winget install Git.Git` | `sudo apt install git` |

Plus a coding agent: [Claude Code](https://claude.com/claude-code),
[Codex](https://github.com/openai/codex) or [Hermes Agent](https://hermes-agent.nousresearch.com/).

## 2. Get the kit

```bash
git clone https://github.com/Sogni-AI/sogni-worlds-kit
cd sogni-worlds-kit
npm install
npm run dev          # optional: play the example world first
```

## 3. Connect your Sogni account

1. Sign up or sign in at [app.sogni.ai](https://app.sogni.ai).
2. Create an API key at [dashboard.sogni.ai/api-key](https://dashboard.sogni.ai/api-key).
3. For a whole world, subscribe to **Unlimited Pro** (or Unlimited) in
   [Wallet & Billing](https://app.sogni.ai/wallet). Why:
   [costs-and-plans.md](costs-and-plans.md).
4. Run:

```bash
node world setup
```

`setup` saves the key to `~/.config/sogni/credentials`, where the Sogni Creative
Agent Skill finds it too, then:

- signs in and shows your plan and how renders will be paid for
- prints the Creative Agent Skill install commands for the agents it finds on
  your machine
- finishes with `node world doctor`

Run `node world doctor` any time something seems off.

## 4. Start a world

```bash
node world new my-trip --title "My Trip"
```

Copy your photos into `worlds/my-trip/photos/`. Use your best originals, not
screenshots or messaging-app copies: every film starts and ends on these exact
pictures, so softness shows. Photos of one shape (all landscape 3:2, say) work
best, because a world has a single canvas.

## 5. Hand it to your agent

Open your agent in the kit folder and say:

> Build a Sogni World from the photos in worlds/my-trip.

It follows [AGENTS.md](../AGENTS.md):

1. ingests the photos
2. asks you about the trip
3. writes the plan and shows it to you
4. quotes the cost
5. renders a canary: one journey and one living photograph
6. screens both

Then it asks you to review:

```bash
node world review
```

A page opens with the takes side by side. Click a clip to hear it, then approve or
reject each one (with a note saying why). Your agent rewrites what you rejected,
renders the rest, and asks you again.

## 6. Play and share

```bash
node world build
node world play
node world export     # then see hosting.md
```

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `doctor` can't find ffmpeg | Install it (table above) and open a new terminal |
| "No Sogni credentials" | `node world setup`, or put `SOGNI_API_KEY=` in `.env` |
| Render stopped with 4087 or 4089 | Your plan's daily or monthly fair-use capacity is used up; see [costs-and-plans.md](costs-and-plans.md#fair-use-plainly) |
| Render interrupted | Run the same command again: it resumes and never double-submits |
| An outline grabbed the wrong thing | Your agent adjusts the clicks and runs `node world select --only <place>-<object>` |
| A film keeps failing the same way | Ask your agent to rewrite that film's direction ([directing-films.md](directing-films.md#retakes)) |
