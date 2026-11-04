# Project lifetime spending

Run `node world spend <world>` to answer what a world has cost from its own
`spending/ledger.jsonl`. `--json` returns exact decimal amounts and a model/provider
breakdown. A normal report needs no API key, account-history search or network.
Keep this small append-only file with the project and back it up with its receipts.
It is private project bookkeeping; `build` and `export` do not publish it.

## What the totals mean

- **Project lifetime:** confirmed usage across video, image, audio, 3D and LLM
  attempts, including rerolls, rejected work and charged failures, less confirmed
  refunds. A failed or refused job is never assumed to be free.
- **Used clips:** the full cost of each unique video source attempt served by the
  last successful approved build. A trim, rewind, HD copy or phone copy adds no
  new generation cost. If one attempt supplied several used excerpts, it counts
  once. A later build replaces this selection; retired attempts stay in lifetime
  spend. Images, speech, music and LLMs remain in the project total. A Seedance
  film's used cost is its 1080p final plus the 480p draft it was made from; the
  report lists drafts and finals apart (`sogni:seedance-2-5 draft` and `… final`).
- **All clips:** every recorded video attempt, including used clips and rerolls.
- **Cash paid:** actual purchases allocated to this project. Buying tokens is
  funding; consuming them is usage. Never add these two totals together.
- **Credits received:** granted vendor/token credits, in their original currency
  and, when documented, their USD value. A $200 credit is $0 cash paid. Its later
  use still has a metered usage value. The ledger does not guess whether a mixed
  account's debit used purchased tokens or promotional tokens.
- **Plan value:** a subscription-covered generation has zero token usage charge;
  its reported compute value is shown separately. Record an allocated subscription
  purchase as funding if it belongs in the project's cash total.

Only actual server settlements or documented external charges are confirmed.
Quotes are estimates, shown separately for unresolved attempts. Missing costs,
missing project IDs and incomplete historical coverage are visible warnings,
never silently filled with zero. USD usage is the settled token value, not a
claim about out-of-pocket cash. Currencies stay separate; no exchange rate is guessed.

## Automatic capture and older projects

Every Kit generation command journals an attempt before submitting it. The SDK's
settled project cost is captured through a video's existing result read; image,
3D and audio callers use one completion lookup. Writer/judge LLM stream settlements
are captured even when the answer is rejected and tried again. A disconnected or cancelled request stays
unresolved until there is evidence of its charge. A cost lookup failure preserves
the media and reports the accounting gap. If bookkeeping fails after a paid call,
the result is preserved and further paid submissions in that session are blocked.
Repair the ledger and reconcile unresolved receipts before restarting. A damaged
ledger stops a new submission before it is paid for.
Concurrent imports serialize their checks and writes, so conflicting receipts
cannot both be accepted. Applied correction references are idempotent across aliases.

On the first tracked session, existing Kit media receipts are imported once from
the known receipt folders. Later reports read only the ledger. To import receipts
added after that initial pass:

```bash
node world spend my-world --import-journals
```

Older receipts often contain a quote but no actual charge. Importing them cannot
recover removed receipts, old LLM charges, external generations or past funding.
The coverage warning remains explicit. For a particular unresolved Sogni media
project, request one fresh settlement lookup (no polling or account-wide scan):

```bash
node world spend my-world --reconcile <project-id>
```

This option signs in and looks up only the named, already recorded media project.
It can be repeated for additional IDs. External writer evaluation calls are
recorded as unresolved because an OpenAI-compatible response has no standard
actual-price field. Import their vendor receipts rather than using Sogni's rates.

For a custom project, import a `coverage` event with `historicalCoverage` describing
the verified scope and optionally `trackedSince` (an ISO date). State any gaps;
do not declare completeness without checking source receipts. Coverage notes
never clear unresolved charge warnings.

## External generations, purchases and credits

After using the Creative Agent Skill or another tool outside the Kit, import
its sanitized receipt before starting the next batch. Include rejected attempts
and rerolls. Use a stable provider project ID to prevent double counting. Preserve
the original receipt privately; do not put prompts, API keys, wallet details,
account balances or credit-grant administration responses in this ledger.

`--record` accepts one JSON event, or an array of events, with `type` and `data`:

```json
[
  {
    "type": "funding",
    "data": {
      "reference": "vendor:grant-example",
      "kind": "credit",
      "provider": "sogni",
      "currency": "spark",
      "amount": "40000",
      "cashUSD": "0",
      "creditValueUSD": "200"
    }
  },
  {
    "type": "attempt",
    "data": {
      "provider": "sogni",
      "projectId": "example-project-id",
      "kind": "video",
      "model": "example-model",
      "status": "completed",
      "currency": "spark",
      "charge": { "usd": "4.25", "tokens": "850", "currency": "spark" }
    }
  }
]
```

These are illustrative amounts, not a current quote. With an actual purchase,
use `kind: "purchase"` and its real `cashUSD`. Do not record merely authorized or
planned top-ups as funding. A funding receipt's stable `reference` makes repeat
imports idempotent and rejects conflicting amounts. A quote belongs under
`estimate: {"usd": "…"}`; omit `charge` until it is confirmed. Valid attempt kinds
are `video`, `image`, `audio`, `llm`, `3d` and `other`.
An imported subscription receipt can include `planValueUSD` beside its confirmed
zero `charge`. Conflicting confirmed charges are rejected. A documented vendor
adjustment can supply `correctionReference` with the corrected charge; a routine
duplicate receipt must never be used to overwrite a bill.

```bash
node world spend my-world --record receipts.json
node world spend --project /path/to/custom-world --record receipts.json --json
```

For a custom player, keep one current selection of the source projects it serves:

```bash
node world spend --project /path/to/custom-world --selection release:clips \
  --used <project-id-1> --used <project-id-2>
```

Unprefixed IDs mean Sogni; use `vendor:project-id` for other providers. A selection
replaces only the same named selection; different selections form a union. Import
`{"type":"selection","data":{"name":"release:clips","projectIds":[]}}` to clear
one. For source clips missing IDs, add `unidentified: <count>` to flag the gap.

A confirmed refund event has `type: "refund"` and data `reference`, `attemptId`
(shown in the ledger), `usd` and `tokens`. It reduces usage once; it does not erase
the attempt or create a new purchase. Never infer a refund from a failure.
