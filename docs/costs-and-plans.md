# Costs and plans

Your coding agent (Claude, Codex, Hermes) is billed by whoever provides it. This
page covers what you pay Sogni for the renders. `node world quote` always prints the
real price before anything is rendered. The figures here are from 2026-09.

## What a film costs

Every world film is native 2K MiniMax H3 (FastH3 first-and-last-frame,
two-stage). At pay-as-you-go rates that is **16 Spark per second of film**, and a
Spark is half a US cent:

| Film | Length | Spark | About |
| --- | --- | --- | --- |
| Short moment | 5.9 s (141 frames) | 94 | $0.47 |
| Loop | 8.0 s (192 frames) | 128 | $0.64 |
| Crossing | 12.3 s (294 frames) | 196 | $0.98 |
| Longest crossing | 15.1 s (362 frames) | 241 | $1.21 |

Object selection (SAM 3), narration and music cost cents each. A 3D figure for a
collectible is about 61 Spark ($0.30): Pixal3D 60, the BiRefNet cut-out 1 (as of 2026-10).

**A world**: plan on one loop plus one or two crossings or moments per place, so
about 2.5 films per place and around $2 of first takes per place. Retakes roughly
double that: the first version of *The Long White Cloud* rendered 120 takes for
its 57 films.

| World | Films | First takes | With retakes |
| --- | --- | --- | --- |
| 5-place canary world | ~12 | ~$10 | ~$20 |
| 10 places | ~25 | ~$21 | ~$40 |
| *The Long White Cloud* today, 22 places | 63 | ~$50 | ~$100 |

## Why the Unlimited plan

On a [Sogni Unlimited plan](https://docs.sogni.ai/pricing/unlimited-plan-details/),
MiniMax H3, the LLMs and MiniMax Music 3 are covered within fair use: covered renders
spend no Spark.

| | Unlimited | Unlimited Pro |
| --- | --- | --- |
| Price | $20 / month ($199 / year) | $50 / month ($498 / year) |
| H3 films rendering at once | 2 (FastH3 Turbo) | 4 |
| H3 fair-use capacity | 1× | 2× |
| Queued videos | up to 8 | up to 24 |

**We recommend Unlimited Pro for building a world.** Four H3 films render at
once, which is how a 60-film world renders in an evening, and it has twice the
H3 fair-use capacity, so a big world rarely has to wait for tomorrow. Unlimited
works too, just more slowly. A new card subscription starts with a 3-day free
trial, which covers a canary (up to 6 H3 videos a day, with trial length limits).

[Subscribe in Wallet & Billing](https://app.sogni.ai/wallet). API keys created
under a subscribed account use the plan automatically.

### How the kit bills

- **No setting** (the default): if your account has an active Unlimited plan, the
  kit bills the plan (`subscription`). A job the plan can't cover stops with a clear
  message instead of quietly spending tokens. Without a plan, it bills your Spark
  balance (`tokens`) and refuses to spend more than `SOGNI_MAX_SPARK` in one run
  unless you pass `--yes`.
- `SOGNI_BILLING_MODE=tokens` pays with Premium Spark even when you have a plan. That
  puts the job in the fastest queue, and it keeps going after the plan's daily
  capacity is used up.
- `SOGNI_BILLING_MODE=auto`: the plan pays what it covers and tokens pay the rest.

Every render prints the account, the plan and the billing choice before it submits.

### Fair use, plainly

"Unlimited" is fair-use scheduling, not unmetered compute. Each plan has a daily
fair-use capacity on the Fast network (reset 24 hours after your plan's daily
window starts) and a larger monthly one. When it's used up, the kit reports
**4087** (daily) or **4089** (monthly). Nothing is lost:

- `render` resumes where it stopped,
- your usage and reset times are at [app.sogni.ai/usage](https://app.sogni.ai/usage),
- or switch to Premium Spark for the rest.

## How long it takes

A 2K film takes a few minutes to about fifteen once it starts. *The Long White
Cloud*'s first version, 57 films, took a median of 12 minutes per crossing and 5 per loop,
all 57 in 2.5 hours across two Unlimited accounts rendering in parallel. The whole
first version, from "bring these photos alive" to live, took one night. A person
reviewed it the next morning.
