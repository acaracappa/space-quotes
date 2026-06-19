// Promote a reviewed tidbit from the out/ review area to published content, rebuild the
// static site, and record it in the dedupe ledger. This is the human approval step — run it
// only after out/<slug>/ has PASSED independent verification.
//
// Usage: node tools/publish.mjs <slug>
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slug = process.argv[2];
if (!slug) {
  console.error("usage: node tools/publish.mjs <slug>");
  process.exit(1);
}

const draft = join(ROOT, "out", slug, "draft.md");
if (!existsSync(draft)) {
  console.error(`No reviewed draft at out/${slug}/draft.md`);
  process.exit(1);
}

// 1. promote draft -> published content
copyFileSync(draft, join(ROOT, "content", "tidbits", `${slug}.md`));

// 2. record in the dedupe ledger (filing_id from the fact sheet, if present)
const ledgerPath = join(ROOT, "data", "tidbits-published.json");
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
let filingId = null;
const fsPath = join(ROOT, "out", slug, "factsheet.json");
if (existsSync(fsPath)) filingId = JSON.parse(readFileSync(fsPath, "utf8")).generated_for?.filing_id ?? null;
if (!ledger.published.some((p) => p.slug === slug)) {
  ledger.published.push({ slug, filing_id: filingId });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
}

// 3. rebuild the static site
execFileSync("node", [join(ROOT, "tools", "build-site.mjs")], { stdio: "inherit" });

console.log(`\npublished: content/tidbits/${slug}.md  ->  tidbits/${slug}/`);
console.log("Review the generated files, then commit + push to go live.");
