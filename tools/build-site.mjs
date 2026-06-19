// Static site renderer for tidbits. NO LLM, no network.
// Reads APPROVED tidbits from content/tidbits/*.md + data/quotes.json and renders:
//   tidbits/<slug>/index.html   permalinked page (full SEO/OG + Article JSON-LD)
//   tidbits/index.html          feed of all tidbits (newest first)
//   assets/og/<slug>.png        1200x630 social share card (via ImageMagick)
//   sitemap.xml                 regenerated with all URLs
//
// Usage: node tools/build-site.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://spacequotes.org";
const CONTENT = join(ROOT, "content", "tidbits");

const quotes = JSON.parse(readFileSync(join(ROOT, "data", "quotes.json"), "utf8"));
const quoteById = Object.fromEntries(quotes.map((q) => [q.id, q]));

// --- tiny helpers ---
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escAttr = (s) => esc(s).replace(/'/g, "&#39;");

// minimal frontmatter + markdown-lite parser for our tidbit format
function parse(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, "");
    fm[kv[1]] = v;
  }
  // strip any non-publication HTML comments
  const body = m[2].replace(/<!--[\s\S]*?-->/g, "").trim();
  return { fm, body };
}

const inline = (s) =>
  esc(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${escAttr(u)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

// render markdown-lite body to HTML blocks
function bodyToHtml(body) {
  const blocks = body.split(/\n\s*\n/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    if (lines[0].startsWith(">")) {
      const inner = lines.map((l) => l.replace(/^>\s?/, "")).filter(Boolean);
      const text = inner[0] || "";
      const cite = (inner[1] || "").replace(/^—\s*/, "");
      out.push(`<blockquote class="tq"><p>${inline(text)}</p>${cite ? `<cite>— ${inline(cite)}</cite>` : ""}</blockquote>`);
    } else {
      out.push(`<p>${inline(b.replace(/\n/g, " "))}</p>`);
    }
  }
  return out.join("\n");
}

// plain-text description from the first paragraph
function metaDescription(body) {
  const first = body.split(/\n\s*\n/).find((b) => !b.startsWith(">")) || "";
  const txt = first.replace(/\n/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_>#]/g, "").trim();
  return txt.length > 157 ? txt.slice(0, 154) + "…" : txt;
}

// --- SVG -> PNG OG card via ImageMagick ---
function wrap(text, max) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

// macOS font files (absolute paths so ImageMagick FreeType works without fontconfig/librsvg)
const FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf";
const FONT_ITALIC = "/System/Library/Fonts/Supplemental/Georgia Italic.ttf";

function ogCard(slug, fm, quote) {
  const ogDir = join(ROOT, "assets", "og");
  mkdirSync(ogDir, { recursive: true });
  const pngPath = join(ogDir, `${slug}.png`);
  const titleLines = wrap(fm.title, 38).slice(0, 4);
  const qLines = wrap(`“${quote.quote}”`, 58).slice(0, 3);

  const args = [
    "-size", "1200x630", `gradient:#0a0a2a-#0a0a0f`,
    "-fill", "#5b8cff", "-draw", "rectangle 0,0 1200,6",
    // wordmark
    "-font", FONT_BOLD, "-fill", "#8aa0d8", "-pointsize", "26", "-annotate", "+80+92", "SPACEQUOTES.ORG",
    // title
    "-fill", "#ffffff", "-pointsize", "52",
  ];
  titleLines.forEach((l, i) => args.push("-annotate", `+80+${195 + i * 62}`, l));
  // quote
  args.push("-font", FONT_ITALIC, "-fill", "#aebbe6", "-pointsize", "30");
  qLines.forEach((l, i) => args.push("-annotate", `+80+${452 + i * 40}`, l));
  // author + source
  args.push("-font", FONT_REG, "-fill", "#6f7fb0", "-pointsize", "22", "-annotate", "+80+590",
    `— ${quote.author}   ·   ${fm.source_label || ""}`);
  args.push(pngPath);

  try {
    execFileSync("magick", args);
    return `/assets/og/${slug}.png`;
  } catch (e) {
    console.warn(`  OG card failed for ${slug}: ${e.message}`);
    return `/assets/og/${slug}.png`;
  }
}

// --- page template ---
function page(fm, body, quote, ogImage, desc) {
  const url = `${SITE}/tidbits/${fm.slug}/`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: fm.title,
    datePublished: fm.date,
    dateModified: fm.date,
    author: { "@type": "Organization", name: "Space Quotes" },
    publisher: { "@type": "Organization", name: "Space Quotes", url: SITE },
    mainEntityOfPage: url,
    image: `${SITE}${ogImage}`,
    description: desc,
    citation: fm.source_url,
    keywords: Array.isArray(fm.tags) ? fm.tags.join(", ") : fm.tags,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(fm.title)} — Space Quotes</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${escAttr(fm.title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${SITE}${ogImage}">
<meta property="article:published_time" content="${fm.date}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(fm.title)}">
<meta name="twitter:description" content="${escAttr(desc)}">
<meta name="twitter:image" content="${SITE}${ogImage}">
<meta name="theme-color" content="#0a0a0f">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0a0f;color:#e6e9f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.6}
.wrap{max-width:720px;margin:0 auto;padding:48px 22px 80px}
a{color:#7da2ff}
nav{font-size:14px;color:#6f7fb0;margin-bottom:32px}
nav a{color:#8aa0d8;text-decoration:none}
h1{font-size:34px;line-height:1.25;margin:0 0 10px;font-weight:800;letter-spacing:-.5px}
.src{font-size:13px;color:#7c8bbf;letter-spacing:.3px;text-transform:uppercase;margin-bottom:28px}
.body p{font-size:18px;margin:0 0 20px}
.tq{margin:32px 0;padding:18px 24px;border-left:3px solid #5b8cff;background:rgba(91,140,255,.07);border-radius:0 8px 8px 0}
.tq p{font-family:Georgia,serif;font-style:italic;font-size:20px;margin:0 0 8px}
.tq cite{font-style:normal;color:#9fb0e0;font-size:15px}
footer{margin-top:48px;padding-top:22px;border-top:1px solid #1c2138;font-size:14px;color:#6f7fb0}
</style>
</head>
<body>
<div class="wrap">
<nav><a href="/">Space Quotes</a> &nbsp;/&nbsp; <a href="/tidbits/">Tidbits</a></nav>
<article>
<h1>${esc(fm.title)}</h1>
<div class="src">${esc(fm.source_label || "")} · ${esc(fm.date)}</div>
<div class="body">
${body}
</div>
</article>
<footer>A <a href="/tidbits/">Space Quotes tidbit</a> — real space-regulatory filings, paired with the words that saw them coming. <a href="/">spacequotes.org</a></footer>
</div>
</body>
</html>
`;
}

function feedPage(items) {
  const rows = items
    .map(
      (it) => `<li><a href="/tidbits/${it.fm.slug}/"><span class="t">${esc(it.fm.title)}</span><span class="m">${esc(it.fm.source_label || "")} · ${esc(it.fm.date)}</span></a></li>`
    )
    .join("\n");
  const desc = "Crafty, sourced tidbits from real space-regulatory filings, each paired with a space quote. From spacequotes.org.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tidbits — Space Quotes</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${SITE}/tidbits/">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/tidbits/">
<meta property="og:title" content="Tidbits — Space Quotes">
<meta property="og:description" content="${escAttr(desc)}">
<meta name="theme-color" content="#0a0a0f">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0a0a0f;color:#e6e9f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.6}
.wrap{max-width:720px;margin:0 auto;padding:48px 22px 80px}
a{color:#7da2ff;text-decoration:none}
nav{font-size:14px;color:#8aa0d8;margin-bottom:28px}
h1{font-size:32px;margin:0 0 8px;font-weight:800}
.lede{color:#9fb0e0;margin:0 0 32px}
ul{list-style:none;padding:0;margin:0}
li{border-top:1px solid #1c2138}
li a{display:block;padding:18px 0}
.t{display:block;font-size:20px;font-weight:600;color:#e6e9f5;margin-bottom:4px}
.m{display:block;font-size:13px;color:#7c8bbf;text-transform:uppercase;letter-spacing:.3px}
li a:hover .t{color:#7da2ff}
</style>
</head>
<body>
<div class="wrap">
<nav><a href="/">← Space Quotes</a></nav>
<h1>Tidbits</h1>
<p class="lede">${esc(desc)}</p>
<ul>
${rows}
</ul>
</div>
</body>
</html>
`;
}

function sitemap(items) {
  const urls = [
    { loc: `${SITE}/`, pri: "1.0", freq: "daily" },
    { loc: `${SITE}/tidbits/`, pri: "0.9", freq: "daily" },
    ...items.map((it) => ({ loc: `${SITE}/tidbits/${it.fm.slug}/`, pri: "0.8", freq: "monthly", lastmod: it.fm.date })),
  ];
  const body = urls
    .map(
      (u) => `  <url>\n    <loc>${u.loc}</loc>\n${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ""}    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// --- build ---
if (!existsSync(CONTENT)) {
  console.error(`No content dir at ${CONTENT}. Approve a tidbit by copying out/<slug>/draft.md there.`);
  process.exit(1);
}
const files = readdirSync(CONTENT).filter((f) => f.endsWith(".md"));
const items = files
  .map((f) => {
    const { fm, body } = parse(readFileSync(join(CONTENT, f), "utf8"));
    return { fm, body };
  })
  .sort((a, b) => (a.fm.date < b.fm.date ? 1 : -1));

for (const it of items) {
  const quote = quoteById[it.fm.quote_id];
  if (!quote) throw new Error(`unknown quote_id ${it.fm.quote_id} in ${it.fm.slug}`);
  const ogImage = ogCard(it.fm.slug, it.fm, quote);
  const desc = metaDescription(it.body);
  const html = page(it.fm, bodyToHtml(it.body), quote, ogImage, desc);
  const dir = join(ROOT, "tidbits", it.fm.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  console.log(`  tidbits/${it.fm.slug}/  (og: ${ogImage})`);
}
mkdirSync(join(ROOT, "tidbits"), { recursive: true });
writeFileSync(join(ROOT, "tidbits", "index.html"), feedPage(items));
writeFileSync(join(ROOT, "sitemap.xml"), sitemap(items));
console.log(`built ${items.length} tidbit(s) + feed + sitemap`);
