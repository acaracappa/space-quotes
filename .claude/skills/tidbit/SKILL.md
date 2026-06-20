---
name: tidbit
description: Generate a grounded, share-ready "space tidbit" for spacequotes.org from real Orbit Sentinel regulatory data — pairs a verified filing with a vetted quote, with mandatory anti-hallucination verification. Use when the user runs /tidbit (optionally with a docket, topic, or filing id) or asks to draft/produce a tidbit. Stops at "ready for review" — never publishes.
---

# /tidbit — generate a grounded space tidbit

Produce ONE share-ready tidbit pairing a real space-regulatory filing with a vetted quote.
Authority is king: **every factual claim must trace to a structured field or the primary
document.** You never publish — you stop at "ready for the user's review."

Background context lives in memory: `tidbit-spec`, `orbit-sentinel-summary-hallucination`,
`site-pivot-direction`. The deterministic tools are already built and proven.

Prereq: `.env` with `MCP_API_URL` + `MCP_API_KEY` exists at repo root (gitignored). All tool
commands run from the repo root. Load env first: `set -a; . ./.env; set +a`.

## Argument modes
Map the user's input to one `find-candidate.mjs` mode:
- `/tidbit` (no args) → `node tools/find-candidate.mjs` (auto: rotates the space-docket allowlist)
- `/tidbit 25-201` (looks like a docket) → `--docket 25-201`
- `/tidbit <uuid>` → `--id <uuid>`
- `/tidbit starlink deorbit` (free text) → `--q "starlink deorbit"`

## Workflow (follow in order)

### 1. Find a candidate
Run the finder in the matching mode. It enforces the gate (primary PDF + hook) and returns a
ranked `shortlist`. Show the user the shortlist (applicant, filing type, docket, score) and use
`candidate` (top-ranked) by default. If the user said "next" or rejects it, take the next
shortlist entry. If `candidate` is null, tell the user nothing met the bar and suggest another
docket/topic — **do NOT lower the bar or invent a subject.**

### 2. Build the fact sheet (deterministic, no LLM)
`node tools/build-factsheet.mjs <filing_id> <slug>` (use the candidate's `filing_id` and
`slug`). This writes `out/<slug>/factsheet.json`, downloads the primary PDF, and extracts its
text to `out/<slug>/source.txt`.

### 3. Read sources and verify the untrusted layer
Read `out/<slug>/factsheet.json` and `out/<slug>/source.txt`.
- **Trusted = `trusted_facts` + `docket_context` (when `counts_complete: true`).**
- **`summary_only_claims` is UNTRUSTED** — the enriched summary can hallucinate. Any specific
  claim from it (altitudes, frequencies, counts) may be used ONLY if you confirm it verbatim in
  `source.txt`. If it is not in the primary text, DROP it.

### 4. Draft the tidbit (filing-quote format + human voice)
Write `out/<slug>/draft.md` using ONLY trusted facts + primary-text-verified claims.

**The centerpiece is a verbatim quote pulled from the filing itself** — a striking, revealing
line the filer actually wrote. Do NOT use a famous space quote; the famous-quote library is
retired (see memory: content-direction-v2). The pull-quote goes in a blockquote at the end with
attribution, and must appear **verbatim** in `source.txt`. This format needs a narrative filing
(opposition, petition, comment, ex parte, letter). If the candidate is a bare form (Form 312,
cost-recovery declaration) with no quotable human line, it does not qualify — go back to step 1.

```
---
slug: <slug>
title: "<specific headline naming the actor + the action>"
date: <filed_date>
source_label: "<agency> · <docket> · <submission type>"
source_url: "<source_url from factsheet>"
tags: [<3-5 kebab tags>]
faq:
  Q: <question a reader would ask>
  A: <answer — only verified facts, no new claims>
  Q: <2-3 Q&As total>
  A: <...>
---

<Lede: what happened, grounded. Build it around what the filer actually said, weaving in a
short verbatim quote. Vary the opening — do NOT start with "On <date>, <Entity> filed...">

<Second graf: stakes/context, grounded. Cite docket counts from docket_context. End on a
concrete fact, not a flourish.>

> "<verbatim line pulled from the filing>"
> — <who said it> , <agency> docket <docket>

*Sources: [<primary doc> →](<source_url>) · Orbit Sentinel (docket <docket>)*
```
Target ~120–170 words. Every number, name, date, and quoted phrase must be traceable.

**Voice rules (strict — enforced by `tools/style-check.mjs`):** no em-dashes in OUR prose
(verbatim quotes keep theirs); no "Why it matters." label; no metaphor/poetic closers; vary
openings; banned phrases include "isn't just… it's", "quiet sign", "unglamorous", "in plain
terms", "the striking part", "reads as". Plain, specific, trade-reporter voice. Run
`node tools/style-check.mjs out/<slug>/draft.md` and fix anything it flags.

### 5. Independent adversarial verification (MANDATORY)
Spawn a fresh subagent (Agent tool, general-purpose) as an adversarial fact-checker. Give it
ONLY the paths to `factsheet.json`, `source.txt`, and `draft.md` — not your reasoning. Instruct
it: for every factual claim, mark SUPPORTED (quote exact source) or UNSUPPORTED; ignore the
epigraph and metaphor bridge except concrete claims; scrutinize the "Why it matters" paragraph
hardest; confirm counts match a complete tally (`counts_complete: true`); default to
UNSUPPORTED on doubt; return JSON `{claims[], unsupported_count, verdict: PASS|FAIL, notes}`.

- **FAIL** → fix exactly the flagged claims (reword to match source, or drop them) and
  re-verify with a fresh subagent. Max 2 revision rounds.
- Still FAIL after 2 rounds → do NOT present as ready. Surface the unsupported claims to the
  user and stop.

### 6. Write the grounding report and present
On PASS, write `out/<slug>/grounding.md` — a table of every claim → source field/quote →
supported. Then present to the user: the rendered tidbit, the PASS verdict, the grounding
table, and the candidate's source link. State clearly it is **ready for review, not published**
(publishing and the `data/tidbits-published.json` ledger update are a separate later step).

## Hard rules
- Never assert a fact not in `trusted_facts` or verbatim in `source.txt`.
- Never use a `summary_only_claims` specific without primary-text confirmation.
- Never invent, reattribute, or alter a quote — only `data/quotes.json`.
- Never skip step 5. A tidbit that has not passed independent verification is not done.
- Never publish or edit the live site from this skill.
