// Candidate finder + auto-gate + quality ranking for /tidbit. NO LLM.
// Gate (hard pass/fail): a primary PDF (something to verify against) AND a hook (contested
// docket or decisive filing). Quality score (soft ranking among passers): prefer
// organizational filers and substantive filing types over individual/ex-parte notices.
// Returns a ranked shortlist; the skill drafts the top one or the human picks "next".
// Never lowers the gate — if nothing qualifies it says so.
//
// Modes:
//   node tools/find-candidate.mjs                  # auto: rotate the space-docket allowlist
//   node tools/find-candidate.mjs --docket 25-201  # qualifying filings in a docket
//   node tools/find-candidate.mjs --q "deorbit"    # qualifying FCC filings matching a topic
//   node tools/find-candidate.mjs --id <uuid>      # a specific filing
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apiGet } from "./lib/api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const idArg = getArg("--id");
const docketArg = getArg("--docket");
const qArg = getArg("--q");

const publishedLedger = readJson("data/tidbits-published.json").published || [];
const publishedIds = new Set(publishedLedger.map((p) => p.filing_id));

const SUBSTANTIVE = ["APPLICATION", "MODIFICATION", "PETITION", "OPPOSITION", "SUPPLEMENT", "TRANSFER_OF_CONTROL"];
const ORG_TYPES = ["company", "government", "organization", "nonprofit"];

const kebab = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

const suggestSlug = (f) =>
  (kebab(f.applicant?.canonical_name || f.applicant_name || f.source_id) + (f.docket_number ? "-" + f.docket_number : ""))
    .replace(/--+/g, "-")
    .slice(0, 50);

async function docketSnapshot(docket) {
  if (!docket) return null;
  const dk = await apiGet(`/api/v1/filings?docket=${encodeURIComponent(docket)}&per_page=100`);
  const rows = dk.data || [];
  const byType = {};
  for (const r of rows) byType[r.filing_type] = (byType[r.filing_type] || 0) + 1;
  return {
    docket,
    total: dk.pagination?.total ?? rows.length,
    by_type: byType,
    oppositions: byType.OPPOSITION || 0,
    petitions: byType.PETITION || 0,
    comments: byType.COMMENT || 0,
  };
}

function hookFrom(snap, filing) {
  if (["PETITION", "OPPOSITION", "EX_PARTE"].includes(filing.filing_type))
    return { hook: true, why: `filing is a ${filing.filing_type}` };
  if (!snap) return { hook: false, why: "no docket context" };
  if (snap.oppositions + snap.petitions >= 1)
    return { hook: true, why: `docket has ${snap.oppositions} oppositions / ${snap.petitions} petitions` };
  if (snap.comments >= 10) return { hook: true, why: `docket has ${snap.comments}+ comments (contested)` };
  return { hook: false, why: "docket not contested" };
}

function scoreCandidate(f, snap) {
  let s = 0;
  const breakdown = [];
  const et = (f.applicant?.entity_type || "").toLowerCase();
  if (ORG_TYPES.includes(et)) { s += 3; breakdown.push(`org filer (${et}) +3`); }
  else if (et && !["person", "individual"].includes(et)) { s += 1; breakdown.push(`filer ${et} +1`); }
  else { breakdown.push(`individual filer +0`); }

  if (SUBSTANTIVE.includes(f.filing_type)) { s += 3; breakdown.push(`${f.filing_type} +3`); }
  else if (f.filing_type === "OTHER") { s += 1; breakdown.push("OTHER +1"); }
  else if (f.filing_type === "EX_PARTE") { s += 0.5; breakdown.push("EX_PARTE +0.5"); }

  if (snap) {
    const c = Math.min(2, (snap.oppositions + snap.petitions) * 0.5 + snap.comments * 0.02);
    if (c > 0) { s += c; breakdown.push(`contested +${c.toFixed(2)}`); }
  }
  return { score: +s.toFixed(2), breakdown };
}

async function evaluate(filingId, snapCache) {
  if (publishedIds.has(filingId)) return { pass: false, reason: "already published" };
  const f = await apiGet(`/api/v1/filings/${filingId}`);
  const hasPdf = (f.attachments || []).length > 0;
  let snap = snapCache[f.docket_number];
  if (f.docket_number && snap === undefined) snap = snapCache[f.docket_number] = await docketSnapshot(f.docket_number);
  const { hook, why } = hookFrom(snap, f);
  const pass = hasPdf && hook;
  const reasons = [hasPdf ? "has primary PDF" : "NO primary PDF", hook ? `hook: ${why}` : `no hook: ${why}`];
  if (!pass) return { pass: false, reason: reasons.join("; ") };
  const { score, breakdown } = scoreCandidate(f, snap);
  return {
    pass: true,
    score,
    candidate: {
      filing_id: f.id,
      slug: suggestSlug(f),
      title: f.title,
      applicant: f.applicant?.canonical_name,
      applicant_type: f.applicant?.entity_type,
      filed_date: f.filed_date,
      docket: f.docket_number,
      filing_type: f.filing_type,
      source_url: f.source_url,
      has_pdf: hasPdf,
      score,
      score_breakdown: breakdown,
      gate_reasons: reasons,
      docket_snapshot: snap,
    },
  };
}

// Evaluate rows (substantive first) and collect passers, capped to keep it fast.
async function collectQualifying(rows, snapCache, skipped, { maxEvals = 14, maxPass = 6 } = {}) {
  const passers = [];
  let evals = 0;
  for (const r of rows) {
    if (evals >= maxEvals || passers.length >= maxPass) break;
    evals++;
    const res = await evaluate(r.id, snapCache);
    if (res.pass) passers.push(res.candidate);
    else skipped.push({ filing_id: r.id, title: r.title?.slice(0, 50), reason: res.reason });
  }
  return passers;
}

const orderRows = (rows) =>
  rows.slice().sort((a, b) => {
    const sa = SUBSTANTIVE.includes(a.filing_type) ? 0 : a.filing_type === "COMMENT" ? 2 : 1;
    const sb = SUBSTANTIVE.includes(b.filing_type) ? 0 : b.filing_type === "COMMENT" ? 2 : 1;
    return sa - sb;
  });

async function rowsForDocket(docket) {
  const dk = await apiGet(`/api/v1/filings?docket=${encodeURIComponent(docket)}&per_page=50`);
  return orderRows(dk.data || []);
}

async function main() {
  const snapCache = {};
  const skipped = [];
  let passers = [];
  let mode;

  if (idArg) {
    mode = "directed:id";
    const res = await evaluate(idArg, snapCache);
    if (res.pass) passers.push(res.candidate);
    else skipped.push({ filing_id: idArg, reason: res.reason });
  } else if (docketArg) {
    mode = "directed:docket";
    passers = await collectQualifying(await rowsForDocket(docketArg), snapCache, skipped);
  } else if (qArg) {
    mode = "directed:q";
    const sr = await apiGet(`/api/v1/filings?agency=FCC&q=${encodeURIComponent(qArg)}&per_page=25`);
    passers = await collectQualifying(orderRows(sr.data || []), snapCache, skipped);
  } else {
    mode = "auto";
    const { dockets } = readJson("data/space-dockets.json");
    for (const d of dockets) {
      const got = await collectQualifying(await rowsForDocket(d.docket), snapCache, skipped, { maxEvals: 8, maxPass: 3 });
      got.forEach((c) => (c.docket_label = d.label));
      passers.push(...got);
      if (passers.length >= 6) break;
    }
  }

  passers.sort((a, b) => b.score - a.score || (a.filed_date < b.filed_date ? 1 : -1));
  const shortlist = passers.slice(0, 3);
  const out = shortlist.length
    ? { mode, candidate: shortlist[0], shortlist, skipped: skipped.slice(0, 8) }
    : { mode, candidate: null, message: "No filing met the publishability bar (primary PDF + hook).", skipped: skipped.slice(0, 12) };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
