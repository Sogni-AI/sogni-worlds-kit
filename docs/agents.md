# Your agent

No coding agent? `node world agent` does the agent's job with Sogni's own LLMs,
on your Sogni API key alone: [agent.md](agent.md).

The kit is built for coding agents that can run shell commands and read files.
They all find the same instructions, [AGENTS.md](../AGENTS.md), and the same
commands (`node world …`). Pick the one you already use.

## Contents

- Claude Code
- Codex
- Hermes Agent (and running it on Sogni's own LLMs)
- The Sogni Creative Agent Skill — what it adds and how to install it
- The sogni-worlds skill — start a world from any folder
- What to say to your agent

## Claude Code

```bash
cd sogni-worlds-kit
claude
```

Claude Code reads `CLAUDE.md`, which imports `AGENTS.md`. Install the Creative
Agent Skill as a plugin, inside Claude Code:

```
/plugin marketplace add Sogni-AI/sogni-creative-agent-skill
/plugin install sogni-creative-agent@sogni
```

Claude reads full-size images natively, which suits the "look at every still at
full size" rule.

## Codex

```bash
cd sogni-worlds-kit
codex
```

Codex reads `AGENTS.md`. Install the skill as a plugin:

```bash
codex plugin marketplace add Sogni-AI/sogni-creative-agent-skill
codex plugin add sogni-creative-agent@sogni
```

## Hermes Agent

```bash
cd sogni-worlds-kit
hermes
```

[Hermes Agent](https://hermes-agent.nousresearch.com/) reads `AGENTS.md` from the
folder it starts in. Install the skill from the Hermes Skills Hub, plus its CLI:

```bash
hermes skills install skills-sh/sogni-ai/sogni-creative-agent-skill/sogni-creative-agent-skill
npm install -g @sogni-ai/sogni-creative-agent-skill@latest
sogni-agent-hermes doctor
```

Run `/reset` in Hermes so it loads the skill.

### Running Hermes on Sogni's own LLMs (experimental)

Hermes can use Sogni's OpenAI-compatible endpoint, so the whole stack runs on
Sogni with one API key. Unlimited plans include Sogni's LLMs. Add a provider to
`~/.hermes/config.yaml`:

```yaml
providers:
  sogni:
    base_url: https://api.sogni.ai/v1
    key_env: SOGNI_API_KEY
    extra_body:
      sogni_tools: false   # the kit runs the media tools itself; don't let the API add its own
```

Then choose it with `hermes model` and pick a model:

| Model | Why |
| --- | --- |
| `deepseek-v4-flash-vision-exp-dspark-1m` | 1M-token context, reads images; needs an Unlimited plan, Premium Spark or SOGNI |
| `qwen3.6-35b-a3b-gguf-iq4xs` | Reads images; lighter |

Two settings matter for this kit:

- **Images:** turn on native image input with
  `hermes config set agent.image_input_mode native`. The endpoint accepts images up
  to 1024 px on the long side, so point the agent at `.cache/preview/<place>.jpg`
  (`ingest` writes these) rather than the full-size stills.
- **Honest status:** we have not yet measured whether these models can build a whole
  world end to end. Frontier agents built the official worlds. Treat a Sogni-LLM build
  as an experiment: expect to steer more, and review everything. The pipeline's
  checks (`lint`, `screen`, and the person's review) are the same whichever model
  drives.

Sogni's docs for this setup:
[Hermes Agent integration](https://docs.sogni.ai/sogni-intelligence/integration-hermes-agent/).

## The Sogni Creative Agent Skill

The kit's commands call the Sogni SDK directly for everything a photo world needs.
The [Creative Agent Skill](https://github.com/Sogni-AI/sogni-creative-agent-skill)
gives your agent the rest of Sogni's models as one command, `sogni-agent`, using the
same API key and plan:

- paint places when there are no photos (Krea 2 Turbo)
- put the same person or character into a new picture, or make an identity-true
  keyframe (Sogni Krea 2 Identity Edit)
- one-off test films, sound effects, background removal, 3D collectibles (Pixal3D)

`node world setup` detects Claude Code, Codex and Hermes and prints the right
install commands. It always installs the CLI too:

```bash
npm install -g @sogni-ai/sogni-creative-agent-skill@latest
sogni-agent doctor
```

One key serves both: the kit reads `SOGNI_API_KEY` from your environment, this
repo's `.env`, or `~/.config/sogni/credentials`, which is the file the skill's own
setup writes.

## The sogni-worlds skill

[`skills/sogni-worlds/SKILL.md`](../skills/sogni-worlds/SKILL.md) teaches your agent
to start a world from anywhere: it fetches this kit and hands over to AGENTS.md.
Install it once:

| Agent | Install |
| --- | --- |
| Claude Code | `mkdir -p ~/.claude/skills && cp -r skills/sogni-worlds ~/.claude/skills/` |
| Codex | `mkdir -p ~/.codex/skills && cp -r skills/sogni-worlds ~/.codex/skills/` |
| Hermes | add this repo's `skills/` folder to `skills.external_dirs` in `~/.hermes/config.yaml` |

## What to say to your agent

> Build a Sogni World from the photos in worlds/my-trip.

Other good openers:

- "Plan a world from these photos, but don't render anything until I've seen the plan."
- "Make a three-place canary world from my best three photos so I can see the quality."
- "Add narration in my voice. The recording is voices/me.m4a and I say: '…'"
- "The ferry crossing dissolved. Fix the direction and render it again."
- "What's left before we can publish?"
