// Deterministic fact-sheet builder. NO LLM. Turns one filing into a
// source-tagged allowlist of facts that a tidbit draft may use.
//
// Core rule (see memory: orbit-sentinel-summary-hallucination):
//   - structured primary fields  -> trusted facts (each carries provenance)
//   - the enriched `summary` text -> NOT trusted; surfaced separately as
//     `summary_only_claims` that must be verified against the primary PDF or dropped.
//
// Usage: node tools/build-factsheet.mjs <filing_id> <slug>
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { apiGet, apiDownload, ENV } from "./lib/api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [filingId, slug] = process.argv.slice(2);
if (!filingId || !slug) {
  console.error("usage: node tools/build-factsheet.mjs <filing_id> <slug>");
  process.exit(1);
}

const outDir = join(ROOT, "out", slug);
mkdirSync(outDir, { recursive: true });

const f = await apiGet(`/api/v1/filings/${filingId}`);
const srcUrl = f.source_url || null;

// --- trusted facts: structured fields only, each with provenance ---
const facts = [];
const add = (claim, value, field) => {
  if (value === null || value === undefined || value === "") return;
  facts.push({ claim, value: String(value), source_field: field, source_url: srcUrl });
};
add("Filer (resolved entity)", f.applicant?.canonical_name, "applicant.canonical_name");
add("Filer entity type", f.applicant?.entity_type, "applicant.entity_type");
add("Filer country", f.applicant?.country, "applicant.country");
add("Filing agency", f.source_agency, "source_agency");
add("Filing type (classified)", f.filing_type, "filing_type");
add("Document title (as filed)", f.title, "title");
add("Date filed", f.filed_date, "filed_date");
add("FCC docket number", f.docket_number, "docket_number");
add("Source record ID", f.source_id, "source_id");
const md = f.metadata || {};
// FCC-style metadata
add("FCC bureau", md.bureau_name, "metadata.bureau_name");
add("Submission type", md.submission_type, "metadata.submission_type");
add("Document count", md.document_count, "metadata.document_count");
// ITU / generic space-network metadata
add("Satellite/network name", md.satellite_name, "metadata.satellite_name");
add("Orbit type", md.orbit_type, "metadata.orbit_type");
add("Filing administration", md.administration, "metadata.administration");
// Earliest ITU notification receipt date (structured, from notifications records)
if (md.notifications) {
  try {
    const notes = typeof md.notifications === "string" ? JSON.parse(md.notifications) : md.notifications;
    const dates = (notes || []).map((n) => n.date_of_receipt).filter(Boolean).sort();
    if (dates.length) {
      add("Earliest ITU notification received", dates[0], "metadata.notifications[].date_of_receipt");
      add("ITU notification count", String(notes.length), "metadata.notifications.length");
    }
  } catch {}
}

// --- docket context: aggregate facts computed from the API, not from prose ---
let docketContext = null;
if (f.docket_number) {
  // Paginate the FULL docket so by_type counts are complete, not a sample.
  const dq = encodeURIComponent(f.docket_number);
  const rows = [];
  let total = null;
  for (let page = 1; ; page++) {
    const dk = await apiGet(`/api/v1/filings?docket=${dq}&per_page=100&page=${page}`);
    const batch = dk.data || [];
    rows.push(...batch);
    const reported = dk.pagination?.total;
    if (typeof reported === "number" && reported > 0 && total === null) total = reported;
    if (batch.length === 0 || (total !== null && rows.length >= total)) break;
    if (page > 50) break; // safety
  }
  const byType = {};
  for (const r of rows) byType[r.filing_type] = (byType[r.filing_type] || 0) + 1;
  const parties = [...new Set(rows.map((r) => r.applicant_name).filter(Boolean))];
  if (total === null) total = rows.length;
  const complete = rows.length >= total;
  docketContext = {
    docket: f.docket_number,
    total_filings: total,
    counted: rows.length,
    counts_complete: complete,
    by_type: byType, // complete tally across the docket when counts_complete=true
    distinct_parties: parties.length,
    notable_parties: parties.slice(0, 12),
    provenance: `GET /api/v1/filings?docket=${dq} (all pages)`,
  };
}

// --- summary-only claims: UNTRUSTED, must be verified against primary PDF ---
const summaryOnly = [];
if (f.summary) {
  summaryOnly.push({
    text: f.summary,
    status: "UNVERIFIED",
    rule: "Enriched summary is LLM-generated and may hallucinate. Any specific claim (altitudes, frequencies, counts) must be confirmed in the primary PDF before use, else dropped.",
  });
}

// --- primary source: extract text from ALL PDF attachments into source.txt ---
// Applications (Form 312) bundle their prose in separate Narrative/Technical attachments,
// not the first (cover) file. Pull every PDF and concatenate, labelled by filename.
let primary = null;
const atts = (f.attachments || []).filter((a) => {
  const n = (a.filename || a.name || a.title || "").toLowerCase();
  return n.endsWith(".pdf") || !/\.(htm|html|mdb|xml|zip|kml|kmz)$/i.test(n);
});
if (atts.length) {
  const sections = [];
  const tmpPdf = join(outDir, "_att.pdf");
  let firstPdfPath = null;
  let totalBytes = 0;
  const used = [];
  for (const a of atts) {
    let buf;
    try { buf = await apiDownload(`/api/v1/attachments/${a.id}/download`); } catch { continue; }
    // skip obviously-non-PDF payloads
    if (buf.slice(0, 4).toString("latin1") !== "%PDF") continue;
    writeFileSync(tmpPdf, buf);
    const name = a.filename || a.name || a.title || a.id;
    if (!firstPdfPath) { firstPdfPath = join(outDir, "source.pdf"); writeFileSync(firstPdfPath, buf); }
    totalBytes += buf.length;
    try {
      const t = join(outDir, "_att.txt");
      execFileSync("pdftotext", ["-layout", tmpPdf, t]);
      sections.push(`===== ATTACHMENT: ${name} =====\n` + readFileSync(t, "utf8"));
      used.push(name);
    } catch {}
  }
  if (sections.length) {
    writeFileSync(join(outDir, "source.txt"), sections.join("\n\n"));
    primary = { attachments: used, pdf: "out/" + slug + "/source.pdf", text: "out/" + slug + "/source.txt", bytes: totalBytes };
  }
}

const factsheet = {
  generated_for: { filing_id: filingId, slug },
  subject: {
    agency: f.source_agency,
    source_id: f.source_id,
    filing_type: f.filing_type,
    title: f.title,
    filed_date: f.filed_date,
    docket_number: f.docket_number,
    source_url: srcUrl,
    applicant: f.applicant,
  },
  trusted_facts: facts,
  docket_context: docketContext,
  summary_only_claims: summaryOnly,
  primary_source: primary,
  quote_corpus: "data/quotes.json",
  api_base: ENV.MCP_API_URL,
};

const fsPath = join(outDir, "factsheet.json");
writeFileSync(fsPath, JSON.stringify(factsheet, null, 2));
console.log(`wrote ${fsPath}`);
console.log(`  trusted facts: ${facts.length}`);
console.log(`  docket: ${docketContext ? docketContext.docket + " (" + docketContext.total_filings + " filings)" : "none"}`);
console.log(`  primary pdf: ${primary ? primary.bytes + " bytes" + (primary.text ? " (+ text extracted)" : "") : "none"}`);
console.log(`  summary-only (untrusted) claims: ${summaryOnly.length}`);
