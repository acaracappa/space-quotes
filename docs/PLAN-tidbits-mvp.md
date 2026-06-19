# Space Quotes → Tidbits: MVP Plan (v2 — grounding-first)

## Reprioritization (what changed)
The existing quote site is **not sacred**. We will **tear it down and rebuild** a better,
more focused site before go-live. Publishing/SEO/deployment is **not** the risk and not what
this MVP proves.

The risk we must de-risk first, **locally, with no publishing**, is:
> Can we pull *real* filing/comment data, pair it with a *real* quote, and produce a tidbit
> where **every factual claim is grounded in the source — zero hallucination?**

Because authority is king, one invented "filing" is fatal. Accuracy is the existential risk.

## Data access — status
- Production API is **live**: `https://orbit-sentinel.viventine.com/healthz` → 200,
  19 GB DB, 418K+ processed filings, fresh crawls.
- `/healthz`, `/status` are public. **`/api/v1/*` requires an API key** (401 without).
- **Blocker:** no real API key stored locally. Need one minted from
  `https://console.viventine.com`, stored in a gitignored `.env` here
  (`MCP_API_URL=https://orbit-sentinel.viventine.com`, `MCP_API_KEY=...`).
- The `orbit-sentinel-mcp` binary is installed (`/opt/homebrew/bin/orbit-sentinel-mcp`) and
  can be wired as an MCP server once a key exists; raw REST is the fallback.

## The MVP: a local grounding/accuracy harness (no website)

### Anti-hallucination architecture
Principle: **the model never asserts a fact it didn't retrieve.** Separate retrieved facts
from editorial framing; verify framing against facts.

1. **Retrieve** a real filing + its real comments + resolved filer entity → structured fields
   (id, filer entity, date, filing type, docket, title, extracted text, comment records),
   each with a primary-source URL.
2. **Deterministic fact sheet** — code (not LLM) extracts an allowlist of atomic facts, each
   tagged `{claim, source_field, source_url}`. Nothing enters a draft that isn't on this sheet.
3. **Constrained draft** — model writes the tidbit using ONLY fact-sheet claims. No number,
   name, date, or claim may appear that is not sourced. Quote chosen from `quotes.json`.
4. **Adversarial verify (separate, independent pass)** — takes draft + fact sheet, judges per
   sentence whether each factual claim is entailed by the fact sheet. Unsupported → reject.
   Default to reject on doubt. Multiple independent verifiers for high-stakes claims.
5. **Per-claim grounding report** — output includes a table:
   `claim → source_field → supported (Y/N) → source_url`. Every claim auditable in seconds.

### Quote-correlation risk, contained
- **Quote authenticity**: zero risk — quotes come from our pre-vetted `data/quotes.json`,
  never model-generated. No misattribution possible.
- **Forced/nonsensical pairing**: quality gate — model proposes quote + rationale; verifier
  scores genuine-vs-stretch; weak pairings rejected.

### Harness outputs (per run, local files only)
```
out/<slug>/factsheet.json     # deterministic, source-tagged atomic facts
out/<slug>/draft.md           # constrained tidbit draft
out/<slug>/grounding.md       # claim → source → supported? → url  (the audit)
out/<slug>/verdict.json       # verifier result: pass/fail + rejected claims
```

### Success criteria (this is the actual test)
- [ ] Pull N real recent filings *with* public comments from the live API.
- [ ] For each, produce a tidbit where **100% of factual claims trace to a source field**.
- [ ] Every source_url resolves to a real primary document.
- [ ] **Red-team:** inject an unsupported claim into a draft → the verifier **catches and
      rejects it**. (Proves the gate works, not just that clean drafts pass.)
- [ ] Quote pairings are judged genuine, not forced, by the verifier.
- [ ] A human can audit any tidbit's claims-to-source in under a minute.

If these hold on real data, the concept is proven and the full rebuild is justified.

## Build order (revised)
1. **Data access**: wire a gitignored `.env` + a thin API client (REST or MCP). Smoke-test
   against `/api/v1/filings`, comments, entities, semantic search. Confirm field shapes.
2. **Fact-sheet extractor** (deterministic): filing JSON → source-tagged atomic facts.
3. **Quote corpus**: extract `data/quotes.json` from `index.html`; likely expand it so the
   correlation step has range. (Editorial, pre-vetted.)
4. **Draft + verify harness**: constrained draft → adversarial verify → grounding report.
5. **Run on real filings + red-team** the verifier. Review outputs together.

## Deferred until the harness succeeds
- Teardown + focused rebuild of the public site (new IA centered on tidbits, not the quote
  homepage). Planned, not started — gated on the harness proving accuracy.
- `/tidbit` skill packaging, PR-based review gate, GitHub Action build/deploy.
- OG images, feed, sitemap, structured data — all the (low-risk) publishing mechanics.

## Decisions locked
- Quality gate: draft → human approve.
- Data access: MCP-first, WireGuard/REST fallback.
- Cadence: few per week, high quality.
- Site: prepared for full teardown + rebuild before go-live; nothing in the current
  `index.html` is load-bearing for the future site except the (portable) quote corpus.

## TUNING DECISIONS — locked (2026-06-16, after 3 sample runs)
- **Publishability gate (auto):** only draft a tidbit when BOTH hold — (a) a primary
  document exists to verify against (PDF/attachment), and (b) there is a genuine hook
  (contested docket, decisive action/proposal, or named stakes). Thin/ITU-only sources with
  no PDF (e.g. RAADSAT) are auto-skipped, NOT published.
- **Source priority:** 1) FCC contested ECFS dockets (petitions/oppositions + comments + PDF),
  2) Federal Register rulemakings (FCC/FAA/NASA/NOAA), 3) FAA launch operations (endpoint
  shape needs a fix). ITU/UNOOSA = deprioritized, enrichment-only.
- **Format = "more analytical".** Sections, in order:
  1. Headline (specific, names the actor + the action)
  2. `*source_label · date*`
  3. Lede graf — what happened, grounded facts only
  4. **Why it matters.** — 1–3 sentences of significance + stakes/players (still grounded;
     analytical framing allowed but no new unverifiable facts)
  5. Paired quote from `data/quotes.json` (pre-vetted)
  6. One-line bridge (metaphor, asserts no new fact)
  7. Source links (primary doc + Orbit Sentinel docket)
  Target length ~150–200 words. Reference template: `out/ast-deorbit/draft.analytical.md`.
- Every version still passes independent adversarial verification before it can publish.

## RESULTS — grounding harness proven (2026-06-16)
Ran the full harness on a real filing: **AST SpaceMobile deorbit supplement, FCC docket 25-201**
(`out/ast-deorbit/`).

- **Data access**: live REST against production, API key in gitignored `.env`. ✅
- **Deterministic fact sheet** (`tools/build-factsheet.mjs`): 11 trusted structured facts (each
  with `source_field` + `source_url`), full docket tally (145 filings: 94 comments, 8
  oppositions, paginated — not sampled), primary PDF downloaded + text-extracted, enriched
  `summary` quarantined as UNVERIFIED. ✅
- **Primary-source verification**: the summary's "680–690 km" claim was confirmed against the
  primary FCC PDF before use (in the RAADSAT case the same gate would have *rejected* the
  summary's bogus "2920 MHz"). Same gate, honest outcome either way. ✅
- **Independent adversarial verify** (fresh subagents, given only fact sheet + PDF + draft):
  - Red-teamed draft with 2 injected lies (altitude 740–760 km; fabricated "243 satellites")
    → **FAIL, both caught.** ✅
  - First clean draft → **FAIL** — verifier caught a *real* bug I missed (counts were from a
    100-row sample, not the full 145). Fixed the builder to paginate; corrected counts to
    94/8. ✅ (Proof the gate catches subtle self-inflicted errors, not just planted ones.)
  - Corrected clean draft → **PASS, 0 unsupported claims.** ✅
- Output tidbit: `out/ast-deorbit/draft.md`; audit trail: `out/ast-deorbit/grounding.md`.

**Conclusion: the concept is proven.** We can pull real filings + comments, pair with a vetted
quote, and produce a tidbit where every factual claim traces to a structured field or the
primary document — with an independent gate that rejects anything unsupported. The pivot is
justified; proceed to packaging (`/tidbit` skill), then the site rebuild.

## Immediate blocker for the user
Mint an API key at `https://console.viventine.com` and provide it so the harness can run
against real production data. Everything else can be built in parallel, but the accuracy
proof needs the real key.
