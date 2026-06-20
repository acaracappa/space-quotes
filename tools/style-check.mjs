// Anti-AI voice linter for tidbits. NO LLM.
// Checks OUR editorial prose (not verbatim quotes) for AI tells. Fails (exit 1) on violations.
//
// What counts as "our prose": the markdown body, MINUS
//   - frontmatter
//   - blockquote lines (the pull-quote, starting with ">")
//   - text inside quotation marks ("..." or "…", straight or curly) = verbatim source quotes
//   - markdown link targets
//   - the *Sources:* footer line
//
// Usage: node tools/style-check.mjs [file ...]   (defaults to content/tidbits/*.md)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "content", "tidbits");

const BANNED = [
  /\bwhy it matters\b/i,
  /\bisn['’]t just\b/i,
  /\bnot just\b[^.]*\bbut\b/i,
  /\bquiet sign\b/i,
  /\bunglamou?red?\b/i, /\bunglamorous\b/i,
  /\bin plain terms\b/i,
  /\bthe striking part\b/i,
  /\bat the end of the day\b/i,
  /\breads as\b/i,
  /\bit['’]s worth noting\b/i,
  /\bin a very real sense\b/i,
  /\bthe unglamorous (machinery|work|plumbing)\b/i,
  /\bspeaks volumes\b/i,
  /\bbegins with\b[^.]*\bquietly\b/i,
];

// strip everything that is NOT our editorial prose
function prose(body) {
  return body
    .split("\n")
    .filter((l) => !l.trim().startsWith(">")) // pull-quote / blockquotes
    .filter((l) => !/^\s*\*Sources:/i.test(l)) // sources footer
    .join("\n")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // keep link text, drop URL
    .replace(/[""][^""]*[""]/g, " ") // curly double-quoted verbatim spans
    .replace(/"[^"]*"/g, " ") // straight double-quoted verbatim spans
    .replace(/[‘'][^’']{0,40}['’]/g, " "); // short single-quoted spans (not apostrophes-in-words: capped)
}

function frontmatterBody(md) {
  const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m ? m[1] : md).replace(/<!--[\s\S]*?-->/g, "").trim();
}

function check(file) {
  const md = readFileSync(file, "utf8");
  const body = frontmatterBody(md);
  const p = prose(body);
  const issues = [];

  const emdash = (p.match(/—/g) || []).length;
  if (emdash > 0) issues.push(`${emdash} em-dash(es) in prose (use commas/periods; em-dashes only inside verbatim quotes)`);

  for (const re of BANNED) {
    const m = p.match(re);
    if (m) issues.push(`banned phrase: "${m[0]}"`);
  }

  // formulaic opening: first prose sentence starts "On <Month> <day>,"
  const firstPara = body.split(/\n\s*\n/).find((b) => !b.trim().startsWith(">")) || "";
  if (/^On\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i.test(firstPara.trim()))
    issues.push(`formulaic date-led opening ("On <Month> <day>, ...") — vary the lede`);

  return issues;
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(CONTENT).filter((f) => f.endsWith(".md")).map((f) => join(CONTENT, f));

let total = 0;
for (const f of files) {
  const issues = check(f);
  if (issues.length) {
    total += issues.length;
    console.log(`✗ ${basename(f)}`);
    for (const i of issues) console.log(`    - ${i}`);
  } else {
    console.log(`✓ ${basename(f)}`);
  }
}
if (total) {
  console.log(`\n${total} style issue(s). Fix before publishing.`);
  process.exit(1);
}
console.log("\nstyle ok");
