// Static site renderer for tidbits. NO LLM, no network.
// Reads APPROVED tidbits from content/tidbits/*.md + data/quotes.json and renders:
//   index.html                  tidbit-centric homepage
//   tidbits/<slug>/index.html   permalinked tidbit pages (SEO/OG + Article/Breadcrumb JSON-LD)
//   tidbits/index.html          feed (ItemList JSON-LD)
//   assets/og/<slug>.png        1200x630 share cards (ImageMagick native text)
//   assets/og/home.png          brand share card
//   feed.xml                    RSS 2.0
//   sitemap.xml
//
// Usage: node tools/build-site.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://spacequotes.org";
const CONTENT = join(ROOT, "content", "tidbits");

// All outbound links to the company site live behind these constants, so the Orbit Sentinel
// launch is a one-line change. ORBIT_SENTINEL points at the root today; flip it to the dedicated
// landing page (e.g. `${VIVENTINE}/orbit-sentinel`) on launch day and rebuild.
const VIVENTINE = "https://viventine.com";
const ORBIT_SENTINEL = VIVENTINE; // ← flip on launch
const BETA = "https://console.viventine.com";
const sentinelUrl = (content, medium = "referral") =>
  `${ORBIT_SENTINEL}?utm_source=spacequotes&utm_medium=${medium}&utm_campaign=orbit_sentinel&utm_content=${content}`;
const betaUrl = (content) =>
  `${BETA}?utm_source=spacequotes&utm_medium=referral&utm_campaign=orbit_sentinel&utm_content=${content}`;

// Only generate a topic/docket hub once it has at least this many tidbits (avoids thin pages).
const HUB_MIN = 2;
let PROMOTED_TAGS = new Set();
let PROMOTED_DOCKETS = new Set();

const SAME_AS = ["https://www.linkedin.com/in/acaracappa/", "https://github.com/acaracappa", VIVENTINE];
const AUTHOR = {
  "@type": "Person",
  name: "Anthony Caracappa",
  description: "Anthony Caracappa writes Space Quotes, tracking the FCC, ITU and FAA filings that shape life in orbit using tools from viventine.com.",
  url: `${SITE}/about/`,
  sameAs: ["https://www.linkedin.com/in/acaracappa/", "https://github.com/acaracappa"],
};
const AUTHOR_NAME = "Anthony Caracappa";

// Subtle, self-contained "what this runs on" note. Tells the story and gives readers a path
// to explore or try the free beta, without a banner or hard sell.
const BUILT_ON = `<aside style="max-width:680px;margin:46px auto 0;padding:16px 20px;border:1px solid rgba(120,150,255,.18);border-radius:14px;background:rgba(91,140,255,.05);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.65;color:#9fb0e0">Space Quotes is built on <a href="${sentinelUrl('footer')}" style="color:#9fbcff;text-decoration:none">Orbit Sentinel</a>, a space-regulatory data platform that tracks filings across the FCC, ITU, FAA and more.</aside>`;

// Tidbits now use verbatim quotes pulled from the filings themselves (see memory:
// content-direction-v2). The famous-quote library is retired from tidbits.

const DOCKET_LABELS = Object.fromEntries(
  (JSON.parse(readFileSync(join(ROOT, "data", "space-dockets.json"), "utf8")).dockets || []).map((d) => [d.docket, d.label])
);
const TAG_LABELS = {
  fcc: "FCC", itu: "ITU", faa: "FAA", ngso: "NGSO", gso: "GSO", "ka-band": "Ka-band",
  "direct-to-cell": "Direct-to-cell", "ast-spacemobile": "AST SpaceMobile",
  "supplemental-coverage-from-space": "Supplemental Coverage from Space",
};
const humanizeTag = (t) => TAG_LABELS[t] || t.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const docketLabel = (d) => DOCKET_LABELS[d] || `FCC Docket ${d}`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escAttr = (s) => esc(s).replace(/'/g, "&#39;");
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const chip = (text, href) => (href ? `<a class="chiptag" href="${href}">${text}</a>` : `<span class="chiptag">${text}</span>`);

// ---------- parsing ----------
function parse(md, file) {
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
  // Optional FAQ block in frontmatter: lines of "Q: ..." each followed by "A: ..." (single-line).
  const faq = [];
  let pendingQ = null;
  for (const line of m[1].split("\n")) {
    const q = line.match(/^\s*Q:\s*(.+)$/);
    const a = line.match(/^\s*A:\s*(.+)$/);
    if (q) pendingQ = q[1].trim();
    else if (a && pendingQ) { faq.push({ q: pendingQ, a: a[1].trim() }); pendingQ = null; }
  }
  const body = m[2].replace(/<!--[\s\S]*?-->/g, "").trim();
  const docket = (fm.source_label && (fm.source_label.match(/Docket\s+([0-9-]+)/) || [])[1]) || null;
  const mtime = file ? statSync(file).mtime.toISOString() : new Date().toISOString();
  // The pull-quote: the first blockquote in the body (verbatim line from the filing + attribution).
  let pull = null;
  const bq = body.split(/\n\s*\n/).find((b) => b.trim().startsWith(">"));
  if (bq) {
    const inner = bq.split("\n").map((l) => l.replace(/^>\s?/, "")).filter(Boolean);
    const text = (inner[0] || "").replace(/^[“"']|[”"']$/g, "").trim();
    const by = (inner[1] || "").replace(/^—\s*/, "").trim();
    if (text) pull = { text, by };
  }
  return { fm, body, docket, mtime, faq, pull };
}

const inline = (s) =>
  esc(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${escAttr(u)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

// markdown-lite body -> HTML. A paragraph beginning "**Short label.** rest" becomes <h2>+<p>.
function bodyToHtml(body) {
  const out = [];
  for (const b of body.split(/\n\s*\n/)) {
    const lines = b.split("\n");
    if (lines[0].startsWith(">")) {
      const inner = lines.map((l) => l.replace(/^>\s?/, "")).filter(Boolean);
      const text = inner[0] || "";
      const cite = (inner[1] || "").replace(/^—\s*/, "");
      out.push(`<blockquote class="tq"><p>${inline(text)}</p>${cite ? `<cite>— ${inline(cite)}</cite>` : ""}</blockquote>`);
      continue;
    }
    const head = b.match(/^\*\*([^*]{2,42}?)\.?\*\*\s+([\s\S]+)$/);
    if (head) {
      out.push(`<h2 class="why">${inline(head[1])}</h2>\n<p>${inline(head[2].replace(/\n/g, " "))}</p>`);
    } else {
      out.push(`<p>${inline(b.replace(/\n/g, " "))}</p>`);
    }
  }
  return out.join("\n");
}

function metaDescription(body) {
  const first = body.split(/\n\s*\n/).find((b) => !b.startsWith(">")) || "";
  const txt = first.replace(/\n/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_>#]/g, "").trim();
  return txt.length > 157 ? txt.slice(0, 154) + "…" : txt;
}
function teaser(body) {
  const first = body.split(/\n\s*\n/).find((b) => !b.startsWith(">")) || "";
  const txt = first.replace(/\n/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/[*_>#]/g, "").trim();
  return txt.length > 160 ? txt.slice(0, 157) + "…" : txt;
}

// ---------- OG cards (ImageMagick native text; no librsvg/npm) ----------
const FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf";
const FONT_ITALIC = "/System/Library/Fonts/Supplemental/Georgia Italic.ttf";
function wrap(text, max) {
  const words = text.split(/\s+/), lines = [];
  let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > max) { if (cur) lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) lines.push(cur);
  return lines;
}
function magick(args, label) {
  try { execFileSync("magick", args); return true; } catch (e) { console.warn(`  OG card failed for ${label}: ${e.message}`); return false; }
}
function ogCard(slug, fm, pull) {
  const ogDir = join(ROOT, "assets", "og");
  mkdirSync(ogDir, { recursive: true });
  const pngPath = join(ogDir, `${slug}.png`);
  const titleLines = wrap(fm.title, 38).slice(0, 4);
  const qLines = wrap(`“${(pull && pull.text) || fm.title}”`, 58).slice(0, 3);
  const args = ["-size", "1200x630", "gradient:#0a0a2a-#0a0a0f",
    "-fill", "#5b8cff", "-draw", "rectangle 0,0 1200,6",
    "-font", FONT_BOLD, "-fill", "#8aa0d8", "-pointsize", "26", "-annotate", "+80+92", "SPACEQUOTES.ORG",
    "-fill", "#ffffff", "-pointsize", "52"];
  titleLines.forEach((l, i) => args.push("-annotate", `+80+${195 + i * 62}`, l));
  args.push("-font", FONT_ITALIC, "-fill", "#aebbe6", "-pointsize", "30");
  qLines.forEach((l, i) => args.push("-annotate", `+80+${452 + i * 40}`, l));
  args.push("-font", FONT_REG, "-fill", "#6f7fb0", "-pointsize", "22", "-annotate", "+80+590", `— ${(pull && pull.by) || fm.source_label || ""}`, pngPath);
  magick(args, slug);
  return `/assets/og/${slug}.png`;
}
function ogHome() {
  const ogDir = join(ROOT, "assets", "og");
  mkdirSync(ogDir, { recursive: true });
  const png = join(ogDir, "home.png");
  const args = ["-size", "1200x630", "gradient:#0a0a2a-#0a0a0f",
    "-fill", "#5b8cff", "-draw", "rectangle 0,0 1200,6",
    "-font", FONT_BOLD, "-fill", "#ffffff", "-pointsize", "30", "-annotate", "+80+120", "✦ SPACE QUOTES",
    "-pointsize", "62", "-annotate", "+80+260", "The future of space is",
    "-annotate", "+80+330", "written in the fine print.",
    "-font", FONT_ITALIC, "-fill", "#aebbe6", "-pointsize", "30",
    "-annotate", "+80+470", "Real space filings, paired with the words",
    "-annotate", "+80+512", "that saw them coming.",
    "-font", FONT_REG, "-fill", "#6f7fb0", "-pointsize", "22", "-annotate", "+80+590", "Sourced from FCC · ITU · FAA filings  ·  verified before publish", png];
  magick(args, "home");
  return `/assets/og/home.png`;
}

// ---------- shared styles ----------
const STARFIELD = `
.stars,.stars::before,.stars::after{position:fixed;inset:0;content:"";background-repeat:repeat;pointer-events:none}
.stars{z-index:0;background-image:radial-gradient(1px 1px at 20% 30%,#fff,transparent),radial-gradient(1px 1px at 80% 70%,#cdd,transparent),radial-gradient(1px 1px at 50% 50%,#fff,transparent),radial-gradient(1px 1px at 65% 20%,#bcd,transparent),radial-gradient(1px 1px at 30% 80%,#fff,transparent),radial-gradient(1px 1px at 90% 40%,#fff,transparent);background-size:340px 340px;opacity:.55;animation:drift 240s linear infinite}
.stars::before{background-image:radial-gradient(1.6px 1.6px at 75% 25%,#fff,transparent),radial-gradient(1.6px 1.6px at 25% 60%,#9bf,transparent),radial-gradient(1.6px 1.6px at 60% 85%,#fff,transparent),radial-gradient(2px 2px at 12% 18%,#cfe,transparent);background-size:560px 560px;opacity:.4;animation:drift 380s linear infinite reverse}
.stars::after{background-image:radial-gradient(.8px .8px at 40% 12%,#fff,transparent),radial-gradient(.8px .8px at 88% 62%,#bcd,transparent),radial-gradient(.8px .8px at 15% 75%,#fff,transparent),radial-gradient(.8px .8px at 55% 35%,#dde,transparent);background-size:220px 220px;opacity:.5}
.glow{position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(900px 520px at 72% -12%,rgba(91,140,255,.18),transparent 60%),radial-gradient(720px 520px at 8% 8%,rgba(155,123,255,.10),transparent 60%)}
@keyframes drift{to{background-position:340px 340px}}
@media (prefers-reduced-motion:reduce){.stars,.stars::before{animation:none}*{scroll-behavior:auto!important}}`;

// Self-hosted fonts (no external Google request — better LCP + privacy). Latin-subset woff2.
const FONTS = `<link rel="preload" href="/assets/fonts/fraunces-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:'Fraunces';font-style:normal;font-weight:600 800;font-display:swap;src:url(/assets/fonts/fraunces-normal.woff2) format('woff2')}
@font-face{font-family:'Fraunces';font-style:italic;font-weight:500;font-display:swap;src:url(/assets/fonts/fraunces-italic.woff2) format('woff2')}
@font-face{font-family:'Newsreader';font-style:normal;font-weight:400;font-display:swap;src:url(/assets/fonts/newsreader-normal.woff2) format('woff2')}
@font-face{font-family:'Newsreader';font-style:italic;font-weight:400;font-display:swap;src:url(/assets/fonts/newsreader-italic.woff2) format('woff2')}
</style>`;

const ICONS = {
  source: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9-9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5"/></svg>',
  verify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18"/></svg>',
};

// ---------- tidbit page ----------
function page(fm, bodyHtml, pull, ogImage, desc, mtime, related, docket, faq = []) {
  const url = `${SITE}/tidbits/${fm.slug}/`;
  const faqHtml = faq.length
    ? `<section class="faq"><h2>Questions &amp; answers</h2><dl>${faq
        .map((f) => `<dt>${esc(f.q)}</dt><dd>${inline(f.a)}</dd>`)
        .join("")}</dl></section>`
    : "";
  const faqLd = faq.length
    ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }]
    : [];
  const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
  const filedHtml =
    docket || tags.length
      ? `<div class="filed"><span>Filed under</span>${docket ? chip(`Docket ${esc(docket)}`, PROMOTED_DOCKETS.has(docket) ? `/dockets/${docket}/` : null) : ""}${tags
          .map((t) => chip(esc(humanizeTag(t)), PROMOTED_TAGS.has(t) ? `/topics/${t}/` : null))
          .join("")}</div>`
      : "";
  const isoPub = `${fm.date}T09:00:00Z`;
  const article = {
    "@context": "https://schema.org", "@type": "Article",
    headline: fm.title, datePublished: isoPub, dateModified: mtime,
    author: AUTHOR,
    publisher: { "@type": "Organization", name: "Space Quotes", url: SITE, logo: { "@type": "ImageObject", url: `${SITE}/assets/og/home.png`, width: 1200, height: 630 } },
    mainEntityOfPage: url,
    image: { "@type": "ImageObject", url: `${SITE}${ogImage}`, width: 1200, height: 630 },
    description: desc, citation: fm.source_url,
    keywords: Array.isArray(fm.tags) ? fm.tags.join(", ") : fm.tags,
    isPartOf: { "@type": "WebSite", name: "Space Quotes", url: SITE },
  };
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Space Quotes", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Tidbits", item: `${SITE}/tidbits/` },
      { "@type": "ListItem", position: 3, name: fm.title, item: url },
    ],
  };
  const relHtml = related.length
    ? `<aside class="related"><h2>Related tidbits</h2><ul>${related
        .map((r) => `<li><a href="/tidbits/${r.fm.slug}/"><span class="t">${esc(r.fm.title)}</span><span class="m">${esc(r.fm.source_label || "")}</span></a></li>`)
        .join("")}</ul></aside>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(fm.title)} — Space Quotes</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:site_name" content="Space Quotes">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${escAttr(fm.title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${SITE}${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escAttr(fm.title)}">
<meta property="article:published_time" content="${isoPub}">
<meta property="article:modified_time" content="${mtime}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(fm.title)}">
<meta name="twitter:description" content="${escAttr(desc)}">
<meta name="twitter:image" content="${SITE}${ogImage}">
<meta name="theme-color" content="#0a0a0f">
${FONTS}
${ld(article)}
${ld(breadcrumb)}
${faqLd.map(ld).join("\n")}
<style>
:root{color-scheme:dark;--bg:#0a0a0f;--accent:#6f9bff;--text:#eef1fa;--muted:#aebbe6;--dim:#9aa6cf}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Newsreader',Georgia,serif;font-size:19px;line-height:1.7;overflow-x:hidden}
${STARFIELD}
.wrap{position:relative;z-index:1;max-width:680px;margin:0 auto;padding:40px 22px 90px}
a{color:#9fbcff}
nav{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim);margin-bottom:34px}
nav a{color:var(--muted);text-decoration:none}
nav a:focus-visible,article a:focus-visible,.related a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,5.2vw,44px);line-height:1.16;margin:0 0 12px;font-weight:800;letter-spacing:-.4px;padding-bottom:.06em}
.src{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12.5px;color:#9fb0e0;letter-spacing:.4px;text-transform:uppercase;margin-bottom:6px}
.byline{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim);margin-bottom:30px}
.byline a{color:var(--muted);text-decoration:none}
.byline a:hover{color:var(--accent)}
.body p{margin:0 0 22px}
.body h2.why{font-family:'Fraunces',Georgia,serif;font-size:24px;font-weight:700;margin:34px 0 12px;letter-spacing:-.3px}
.tq{margin:34px 0;padding:6px 0 6px 26px;border-left:3px solid var(--accent)}
.tq p{font-style:italic;font-size:23px;margin:0 0 8px;color:#dce4ff}
.tq cite{font-style:normal;color:var(--muted);font-size:15px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.body em{font-style:italic;color:var(--muted)}
.filed{margin-top:38px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.filed span{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-right:2px}
.chiptag{display:inline-block;padding:5px 12px;border-radius:999px;border:1px solid rgba(120,150,255,.28);background:rgba(255,255,255,.03);color:var(--muted);font-size:13px;text-decoration:none}
.chiptag:hover{border-color:var(--accent);color:#fff}
.faq{margin-top:50px;padding-top:28px;border-top:1px solid #1c2138}
.faq h2{font-family:'Fraunces',Georgia,serif;font-size:24px;font-weight:700;margin:0 0 18px;letter-spacing:-.3px}
.faq dl{margin:0}
.faq dt{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-weight:600;font-size:17px;color:#fff;margin:18px 0 6px}
.faq dd{margin:0;color:var(--muted);font-size:17px}
.related{margin-top:48px;padding-top:26px;border-top:1px solid #1c2138;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.related h2{font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim);margin:0 0 14px}
.related ul{list-style:none;padding:0;margin:0}
.related a{display:block;padding:12px 0;text-decoration:none;border-top:1px solid #161a2e}
.related .t{display:block;color:var(--text);font-size:17px;margin-bottom:2px}
.related .m{display:block;color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.3px}
.related a:hover .t{color:var(--accent)}
footer{margin-top:48px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim)}
</style>
</head>
<body>
<div class="stars"></div><div class="glow"></div>
<div class="wrap">
<nav><a href="/">Space Quotes</a> &nbsp;/&nbsp; <a href="/tidbits/">Tidbits</a></nav>
<article>
<h1>${esc(fm.title)}</h1>
<div class="src">${esc(fm.source_label || "")} · ${esc(fm.date)}</div>
<div class="byline">By <a rel="author" href="${AUTHOR.url}">${esc(AUTHOR_NAME)}</a></div>
<div class="body">
${bodyHtml}
</div>
${filedHtml}
</article>
${faqHtml}
${relHtml}
${BUILT_ON}
<footer>Written by <a rel="author" href="${AUTHOR.url}">${esc(AUTHOR_NAME)}</a> · a <a href="/tidbits/">Space Quotes tidbit</a>, the quotable lines from real space-regulatory filings. <a href="/about/">How we source &amp; verify</a></footer>
</div>
</body>
</html>
`;
}

// ---------- shared listing renderer (feed + hubs + hub indexes) ----------
function listingPage({ titleTag, desc, canonical, h1, lede, crumbs, rowsHtml, extraLd = [] }) {
  const crumbNav = crumbs.map((c, i) => (i === 0 ? `<a href="${c.url}">${esc(c.name)}</a>` : ` &nbsp;/&nbsp; ${c.url ? `<a href="${c.url}">${esc(c.name)}</a>` : esc(c.name)}`)).join("");
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url.startsWith("http") ? c.url : `${SITE}${c.url}` })),
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titleTag)}</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:site_name" content="Space Quotes">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${escAttr(h1)} — Space Quotes">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${SITE}/assets/og/home.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/assets/og/home.png">
<meta name="theme-color" content="#0a0a0f">
<link rel="alternate" type="application/rss+xml" title="Space Quotes tidbits" href="${SITE}/feed.xml">
${FONTS}
${[breadcrumb, ...extraLd].map(ld).join("\n")}
<style>
:root{color-scheme:dark;--bg:#0a0a0f;--accent:#6f9bff;--text:#eef1fa;--muted:#aebbe6;--dim:#9aa6cf}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.6;overflow-x:hidden}
${STARFIELD}
.wrap{position:relative;z-index:1;max-width:740px;margin:0 auto;padding:44px 22px 90px}
a{color:#9fbcff;text-decoration:none}
nav{font-size:14px;color:var(--muted);margin-bottom:26px}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,5vw,42px);margin:0 0 10px;font-weight:800;letter-spacing:-.5px}
.lede{color:var(--muted);margin:0 0 34px;font-size:18px;max-width:62ch}
ul{list-style:none;padding:0;margin:0}
li a{display:block;padding:20px 0;border-top:1px solid #1c2138}
li a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.t{display:block;font-size:21px;font-weight:600;color:var(--text);margin-bottom:5px;line-height:1.3;font-family:'Fraunces',Georgia,serif}
.m{display:block;font-size:12.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.3px}
li a:hover .t{color:var(--accent)}
.count{color:var(--dim);font-weight:400;font-size:.6em;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
</style>
</head>
<body>
<div class="stars"></div><div class="glow"></div>
<div class="wrap">
<nav>${crumbNav}</nav>
<h1>${esc(h1)}</h1>
<p class="lede">${esc(lede)}</p>
<ul>
${rowsHtml}
</ul>
${BUILT_ON}
</div>
</body>
</html>
`;
}

const tidbitRow = (it) =>
  `<li><a href="/tidbits/${it.fm.slug}/"><span class="t">${esc(it.fm.title)}</span><span class="m">${esc(it.fm.source_label || "")} · ${esc(it.fm.date)}</span></a></li>`;
const itemListLd = (its) => ({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: its.map((it, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/tidbits/${it.fm.slug}/`, name: it.fm.title })) });

function feedPage(items) {
  const desc = "Sourced tidbits from real FCC, ITU and FAA space filings, each built around a quotable line from the filing itself. From spacequotes.org.";
  return listingPage({
    titleTag: "Tidbits — sourced space-filing dispatches | Space Quotes",
    desc, canonical: `${SITE}/tidbits/`, h1: "Tidbits", lede: desc,
    crumbs: [{ name: "Space Quotes", url: "/" }, { name: "Tidbits", url: "/tidbits/" }],
    rowsHtml: items.map(tidbitRow).join("\n"),
    extraLd: [itemListLd(items)],
  });
}

function topicHub(slug, label, its) {
  const desc = `Space Quotes tidbits on ${label}, sourced from real FCC, ITU and FAA filings, each built around a real line from the filing.`;
  return listingPage({
    titleTag: `${label} — space-policy tidbits | Space Quotes`,
    desc, canonical: `${SITE}/topics/${slug}/`, h1: label,
    lede: `Verified, primary-sourced tidbits tagged “${label}.”`,
    crumbs: [{ name: "Space Quotes", url: "/" }, { name: "Topics", url: "/topics/" }, { name: label, url: `/topics/${slug}/` }],
    rowsHtml: its.map(tidbitRow).join("\n"),
    extraLd: [itemListLd(its)],
  });
}

function docketHub(docket, its) {
  const label = docketLabel(docket);
  const desc = `Every Space Quotes tidbit from FCC docket ${docket} — ${label}. Sourced from primary filings.`;
  return listingPage({
    titleTag: `FCC Docket ${docket} — ${label} | Space Quotes`,
    desc, canonical: `${SITE}/dockets/${docket}/`, h1: `Docket ${docket}`,
    lede: `${label}. Verified tidbits drawn from filings in this FCC proceeding.`,
    crumbs: [{ name: "Space Quotes", url: "/" }, { name: "Dockets", url: "/dockets/" }, { name: `Docket ${docket}`, url: `/dockets/${docket}/` }],
    rowsHtml: its.map(tidbitRow).join("\n"),
    extraLd: [itemListLd(its)],
  });
}

function hubIndex(kind, entries) {
  const isTopic = kind === "topics";
  const h1 = isTopic ? "Topics" : "Dockets";
  const desc = isTopic
    ? "Browse Space Quotes tidbits by topic — orbital debris, spectrum, direct-to-cell and more."
    : "Browse Space Quotes tidbits by FCC docket — every proceeding we've covered.";
  const rows = entries
    .map((e) => `<li><a href="/${kind}/${e.slug}/"><span class="t">${esc(e.label)} <span class="count">${e.n} tidbit${e.n > 1 ? "s" : ""}</span></span><span class="m">${esc(e.sub || "")}</span></a></li>`)
    .join("\n");
  return listingPage({
    titleTag: `${h1} — browse space-policy tidbits | Space Quotes`,
    desc, canonical: `${SITE}/${kind}/`, h1, lede: desc,
    crumbs: [{ name: "Space Quotes", url: "/" }, { name: h1, url: `/${kind}/` }],
    rowsHtml: rows,
  });
}

// ---------- homepage ----------
function homePage(items, topicEntries = [], docketEntries = []) {
  const desc = "Space Quotes surfaces real, sourced tidbits from the FCC, ITU and FAA filings shaping life in orbit, each built around a verbatim line from the filing itself. Verified against primary documents, built to share.";
  const featured = items[0];
  const rest = items.slice(1, 7);
  const homeImg = "/assets/og/home.png";
  const card = (it) =>
    `<a class="card" href="/tidbits/${it.fm.slug}/">
        <div class="card-src">${esc(it.fm.source_label || "")}</div>
        <h3>${esc(it.fm.title)}</h3>
        <p>${esc(teaser(it.body))}</p>
        <span class="card-read">Read the tidbit →</span>
      </a>`;
  const itemList = { "@context": "https://schema.org", "@type": "ItemList", itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/tidbits/${it.fm.slug}/`, name: it.fm.title })) };
  const website = { "@context": "https://schema.org", "@type": "WebSite", name: "Space Quotes", url: SITE, description: desc };
  const org = { "@context": "https://schema.org", "@type": "Organization", name: "Space Quotes", url: SITE, description: "Sourced, verified tidbits from space-regulatory filings, built around the quotable lines operators and regulators actually file.", logo: { "@type": "ImageObject", url: `${SITE}/assets/og/home.png`, width: 1200, height: 630 }, founder: AUTHOR, ...(SAME_AS.length ? { sameAs: SAME_AS } : {}) };
  const pulls = items.map((it) => it.pull).filter((p) => p && p.text);
  const Q = JSON.stringify(pulls.map((p) => ({ q: p.text, a: p.by })));
  const firstPull = pulls[0] || { text: "The future of space is written in the fine print.", by: "Space Quotes" };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Space Quotes — Space-policy tidbits from real FCC, ITU & FAA filings</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${SITE}/">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:site_name" content="Space Quotes">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/">
<meta property="og:title" content="Space Quotes — the real words shaping space, pulled from the filings">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${SITE}${homeImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Space Quotes — the future of space is written in the fine print">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Space Quotes — real space filings, paired with timeless words">
<meta name="twitter:description" content="${escAttr(desc)}">
<meta name="twitter:image" content="${SITE}${homeImg}">
<meta name="theme-color" content="#0a0a0f">
<link rel="alternate" type="application/rss+xml" title="Space Quotes tidbits" href="${SITE}/feed.xml">
${FONTS}
${ld(website)}
${ld(org)}
${ld(itemList)}
<style>
:root{color-scheme:dark;--bg:#0a0a0f;--panel:rgba(255,255,255,.045);--bd:rgba(120,150,255,.18);--accent:#6f9bff;--text:#eef1fa;--muted:#aebbe6;--dim:#9aa6cf;--s:8px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.6;overflow-x:hidden}
${STARFIELD}
.shell{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:0 22px}
a{color:#9fbcff;text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:8px}
header{position:sticky;top:0;z-index:5;backdrop-filter:blur(12px);background:rgba(10,10,15,.72);border-bottom:1px solid rgba(120,150,255,.1)}
.bar{display:flex;align-items:center;justify-content:space-between;height:60px}
.brand{font-weight:800;letter-spacing:.5px;color:#fff;font-size:18px;display:inline-flex;align-items:center;gap:8px}
.brand svg{width:18px;height:18px;color:var(--accent)}
.nav a{color:var(--muted);margin-left:8px;padding:10px 12px;font-size:15px;display:inline-block;border-radius:8px}
.nav a:hover{color:#fff}
section[id]{scroll-margin-top:80px}
.hero{text-align:center;padding:96px 0 60px}
.eyebrow{color:var(--accent);font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(32px,6.4vw,66px);line-height:1.06;margin:20px auto 20px;max-width:15ch;font-weight:800;letter-spacing:-1px;padding-bottom:.08em;background:linear-gradient(180deg,#fff,#b9c6ef);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:clamp(17px,2.3vw,21px);color:var(--muted);max-width:62ch;margin:0 auto 26px}
.rotq{position:relative;min-height:120px;max-width:54ch;margin:0 auto 30px;font-family:'Newsreader',Georgia,serif;font-style:italic;font-size:21px;color:#cdd8f7;transition:opacity .6s;display:flex;flex-direction:column;justify-content:center}
.rotq cite{font-style:normal;font-size:14px;color:var(--dim);margin-top:8px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.cta{display:inline-flex;gap:12px;flex-wrap:wrap;justify-content:center}
.btn{display:inline-block;padding:14px 26px;border-radius:999px;font-weight:600;font-size:15px;transition:transform .15s,border-color .15s,background .15s}
.btn-p{background:linear-gradient(135deg,var(--accent),#8b78ff);color:#fff;box-shadow:0 6px 20px rgba(91,140,255,.30)}
.btn-s{border:1px solid rgba(120,150,255,.34);background:rgba(255,255,255,.03);color:var(--text)}
.btn-s:hover{border-color:var(--accent)}
section{padding:44px 0}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:22px;gap:16px}
.sec-h h2{font-family:'Fraunces',Georgia,serif;font-size:15px;font-weight:600;margin:0;letter-spacing:1.4px;text-transform:uppercase;color:var(--dim)}
.sec-h a{font-size:14px;color:var(--muted)}
.feat{display:block;padding:40px;border-radius:22px;background:radial-gradient(120% 140% at 0% 0%,rgba(111,155,255,.16),rgba(255,255,255,.03) 55%);border:1px solid rgba(120,150,255,.30);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 20px 60px -30px rgba(91,140,255,.5);transition:transform .2s,border-color .2s}
.feat:hover{transform:translateY(-4px);border-color:var(--accent)}
.feat .tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0a0a0f;background:var(--accent);padding:4px 10px;border-radius:999px}
.feat .card-src{color:var(--dim);font-size:13px;text-transform:uppercase;letter-spacing:.4px;margin:18px 0 10px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.feat h3{font-family:'Fraunces',Georgia,serif;font-size:clamp(26px,3.6vw,38px);line-height:1.14;margin:0 0 14px;color:#fff;letter-spacing:-.5px}
.feat p{color:var(--muted);font-size:18px;margin:0 0 18px;max-width:62ch;font-family:'Newsreader',Georgia,serif}
.feat .card-read{color:var(--accent);font-weight:600;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:18px}
.card{display:block;padding:26px;border-radius:16px;background:var(--panel);border:1px solid var(--bd);transition:transform .2s,border-color .2s,background .2s}
.card:hover{transform:translateY(-4px);border-color:var(--accent);background:rgba(91,140,255,.07)}
.card-src{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px}
.card h3{font-family:'Fraunces',Georgia,serif;font-size:20px;line-height:1.25;margin:0 0 12px;color:#fff;letter-spacing:-.3px}
.card p{color:var(--muted);font-size:15px;margin:0 0 16px;font-family:'Newsreader',Georgia,serif;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card-read{color:var(--accent);font-size:14px;font-weight:600}
.topics{display:flex;flex-wrap:wrap;gap:10px}
.topic{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;border:1px solid var(--bd);background:var(--panel);color:var(--muted);font-size:15px;transition:border-color .15s,color .15s,background .15s}
.topic:hover{border-color:var(--accent);color:#fff;background:rgba(91,140,255,.07)}
.topic span{font-size:12px;color:var(--dim);background:rgba(120,150,255,.14);border-radius:999px;padding:1px 8px}
.trust{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:22px;padding:40px;border-radius:22px;background:var(--panel);border:1px solid var(--bd)}
.chip{width:44px;height:44px;border-radius:12px;border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;color:var(--accent);background:radial-gradient(120% 120% at 30% 20%,rgba(111,155,255,.18),transparent);margin-bottom:14px}
.chip svg{width:22px;height:22px}
.trust h3{font-size:17px;margin:0 0 8px;color:#fff}
.trust p{color:var(--muted);font-size:15px;margin:0}
footer{position:relative;z-index:1;border-top:1px solid rgba(120,150,255,.1);margin-top:48px;padding:36px 0;color:var(--dim);font-size:14px}
.foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px}
.foot a{color:var(--muted);padding:6px 0;display:inline-block}
@media (max-width:600px){
  .hero{padding:62px 0 44px}
  h1{letter-spacing:-.3px}
  .nav a{margin-left:0;padding:10px 8px;font-size:14px}
  .feat{padding:28px}
  section{padding:34px 0}
}
@media (prefers-reduced-motion:reduce){.btn:hover,.card:hover,.feat:hover{transform:none}}
</style>
</head>
<body>
<div class="stars"></div><div class="glow"></div>
<header><div class="shell bar">
  <div class="brand">${ICONS.star}SPACE QUOTES</div>
  <nav class="nav"><a href="#latest">Tidbits</a><a href="/topics/">Topics</a><a href="/dockets/">Dockets</a><a href="/tidbits/">Archive</a><a href="/about/">About</a></nav>
</div></header>

<main class="shell">
  <section class="hero">
    <div class="eyebrow">Real filings · Real quotes</div>
    <h1>The future of space is written in the fine print.</h1>
    <p class="sub">We read the filings, comments and rulings shaping life in orbit, then pull the line that actually matters. Sourced from primary documents, verified before it's published.</p>
    <blockquote class="rotq" id="rotq"><span>“${esc(firstPull.text)}”</span><cite>— ${esc(firstPull.by)}</cite></blockquote>
    <div class="cta">
      <a class="btn btn-p" href="#latest">Read the latest</a>
      <a class="btn btn-s" href="/tidbits/">Browse all tidbits</a>
    </div>
  </section>

  ${featured ? `<section id="latest">
    <div class="sec-h"><h2>Latest space-filing tidbit</h2><a href="/tidbits/">All tidbits →</a></div>
    <a class="feat" href="/tidbits/${featured.fm.slug}/">
      <span class="tag">Newest</span>
      <div class="card-src">${esc(featured.fm.source_label || "")} · ${esc(featured.fm.date)}</div>
      <h3>${esc(featured.fm.title)}</h3>
      <p>${esc(teaser(featured.body))}</p>
      <span class="card-read">Read the tidbit →</span>
    </a>
  </section>` : ""}

  ${rest.length ? `<section>
    <div class="sec-h"><h2>More space-policy tidbits</h2></div>
    <div class="grid">${rest.map(card).join("\n")}</div>
  </section>` : ""}

  ${topicEntries.length ? `<section id="topics">
    <div class="sec-h"><h2>Browse by topic</h2><a href="/topics/">All topics →</a></div>
    <div class="topics">${topicEntries.slice(0, 10).map((t) => `<a class="topic" href="/topics/${t.slug}/">${esc(t.label)} <span>${t.n}</span></a>`).join("")}</div>
  </section>` : ""}

  ${docketEntries.length ? `<section id="dockets">
    <div class="sec-h"><h2>Browse by docket</h2><a href="/dockets/">All dockets →</a></div>
    <div class="topics">${docketEntries.slice(0, 10).map((d) => `<a class="topic" href="/dockets/${d.slug}/">${esc(d.label)} <span>${d.n}</span></a>`).join("")}</div>
  </section>` : ""}

  <section id="about">
    <div class="sec-h"><h2>Sourced, verified, built to share</h2></div>
    <div class="trust">
      <div><div class="chip">${ICONS.source}</div><h3>Straight from the source</h3><p>Every tidbit is drawn from primary FCC, ITU and FAA filings, with a link back to the original document.</p></div>
      <div><div class="chip">${ICONS.verify}</div><h3>Verified, not generated</h3><p>Each factual claim is checked against the source record by an independent pass before it's published.</p></div>
      <div><div class="chip">${ICONS.star}</div><h3>The actual words</h3><p>Every tidbit is built around a real line from the filing, quoted verbatim and attributed, never our paraphrase.</p></div>
    </div>
  </section>

  ${BUILT_ON}
</main>

<footer><div class="shell foot">
  <div>✦ Space Quotes — the paperwork of leaving Earth, read between the lines.</div>
  <div><a href="/tidbits/">Tidbits</a> · <a href="/topics/">Topics</a> · <a href="/dockets/">Dockets</a> · <a href="/about/">About</a> · <a href="/terms/">Terms</a> · <a href="/feed.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a> · spacequotes.org</div>
</div></footer>

<script>
(function(){
  var Q=${Q};
  var el=document.getElementById('rotq');if(!el||!Q.length)return;
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  var i=1%Q.length;
  function show(){el.style.opacity=0;setTimeout(function(){el.innerHTML='<span>“'+Q[i].q+'”</span><cite>— '+Q[i].a+'</cite>';el.style.opacity=1;i=(i+1)%Q.length;},600);}
  setInterval(show,7000);
})();
</script>
</body>
</html>
`;
}

// ---------- about / methodology ----------
function aboutPage() {
  const desc = "How Space Quotes works: every tidbit is built from primary FCC, ITU and FAA filings, verified against the source record before publishing, and built around a verbatim line from the filing.";
  const url = `${SITE}/about/`;
  const aboutLd = { "@context": "https://schema.org", "@type": "AboutPage", name: "About Space Quotes", url, description: desc, author: AUTHOR, mainEntity: AUTHOR, isPartOf: { "@type": "WebSite", name: "Space Quotes", url: SITE }, publisher: { "@type": "Organization", name: "Space Quotes", url: SITE, logo: { "@type": "ImageObject", url: `${SITE}/assets/og/home.png`, width: 1200, height: 630 }, founder: AUTHOR, sameAs: SAME_AS } };
  const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Space Quotes", item: `${SITE}/` }, { "@type": "ListItem", position: 2, name: "About", item: url }] };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>About & methodology — how Space Quotes sources and verifies | Space Quotes</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:site_name" content="Space Quotes">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="About & methodology — Space Quotes">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${SITE}/assets/og/home.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/assets/og/home.png">
<meta name="theme-color" content="#0a0a0f">
${FONTS}
${ld(aboutLd)}
${ld(breadcrumb)}
<style>
:root{color-scheme:dark;--bg:#0a0a0f;--accent:#6f9bff;--text:#eef1fa;--muted:#aebbe6;--dim:#9aa6cf}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Newsreader',Georgia,serif;font-size:19px;line-height:1.75;overflow-x:hidden}
${STARFIELD}
.wrap{position:relative;z-index:1;max-width:680px;margin:0 auto;padding:40px 22px 90px}
a{color:#9fbcff}
nav{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim);margin-bottom:34px}
nav a{color:var(--muted);text-decoration:none}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(32px,5.4vw,46px);line-height:1.12;margin:0 0 14px;font-weight:800;letter-spacing:-.5px;padding-bottom:.06em}
.lede{color:var(--muted);font-size:21px;margin:0 0 36px}
h2{font-family:'Fraunces',Georgia,serif;font-size:25px;font-weight:700;margin:40px 0 12px;letter-spacing:-.3px}
p{margin:0 0 20px}
ul{padding-left:22px;margin:0 0 20px}
li{margin:0 0 12px}
strong{color:#fff}
.principle{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
footer{margin-top:50px;padding-top:24px;border-top:1px solid #1c2138;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim)}
</style>
</head>
<body>
<div class="stars"></div><div class="glow"></div>
<div class="wrap">
<nav><a href="/">Space Quotes</a> &nbsp;/&nbsp; About</nav>
<h1>About &amp; methodology</h1>
<p class="lede">Space Quotes turns the dense public record of space regulation into short, sourced, shareable dispatches, each built around a real line pulled from the filing itself.</p>

<h2>Where the facts come from</h2>
<p>Every tidbit is built from <strong>primary filings in the public regulatory record</strong>: the FCC (ECFS and IBFS), the ITU, the FAA, and the dockets where the future of orbit is actually argued. We surface them through <a href="${sentinelUrl('about_methodology')}">Orbit Sentinel</a>, our space-regulatory data platform, which crawls and links these sources, and every tidbit links back to the original document so you can read it yourself. Orbit Sentinel is live and free during beta, so you can explore the filings yourself or <a rel="sponsored" href="${betaUrl('about_try')}">try the free beta</a>.</p>

<h2>How we keep it accurate</h2>
<p>Accuracy is the entire value of the site, so the process is built to make a wrong claim hard to publish:</p>
<ul class="principle">
<li><strong>We separate facts from framing.</strong> Every factual claim is drawn only from structured fields in the official record or text quoted directly from the primary document.</li>
<li><strong>We treat machine summaries as untrusted.</strong> Automated summaries can be wrong, so any specific claim (an altitude, a frequency, a count) is confirmed against the primary document or dropped.</li>
<li><strong>We verify before we publish.</strong> An independent check reviews every draft against its sources and rejects anything that isn't supported. A tidbit that doesn't pass doesn't go up.</li>
<li><strong>Every quote is verbatim.</strong> The line at the heart of each tidbit is pulled straight from the filing, quoted exactly and attributed to whoever wrote it. We never paraphrase it or make it up.</li>
</ul>

<h2>Why the quotes come from the filings</h2>
<p>A docket number is easy to ignore. The actual sentence a company, a lawyer, or a rural carrier wrote into the record is not. Pulling the real line out of the paperwork is how we make a filing readable, and worth sharing, without putting words in anyone's mouth.</p>

<h2>Who writes Space Quotes</h2>
<p>Space Quotes is written by <strong>Anthony Caracappa</strong>, who tracks the FCC, ITU and FAA filings that shape life in orbit using tools from <a href="${sentinelUrl('about_byline')}">viventine.com</a>. You can find him on <a rel="me" href="https://www.linkedin.com/in/acaracappa/">LinkedIn</a> and <a rel="me" href="https://github.com/acaracappa">GitHub</a>.</p>

<h2>Corrections</h2>
<p>Found an error? Accuracy is the whole point of this site, and we'll correct or remove anything that turns out to be wrong.</p>

<footer><a href="/tidbits/">Browse the tidbits →</a> · spacequotes.org</footer>
</div>
</body>
</html>
`;
}

// ---------- terms / disclaimer ----------
function termsPage() {
  const desc = "Terms and disclaimer for Space Quotes: the site and its content are provided as is, for informational purposes only, with no warranties and no liability.";
  const url = `${SITE}/terms/`;
  const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Space Quotes", item: `${SITE}/` }, { "@type": "ListItem", position: 2, name: "Terms", item: url }] };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terms & disclaimer | Space Quotes</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:site_name" content="Space Quotes">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="Terms & disclaimer — Space Quotes">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${SITE}/assets/og/home.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/assets/og/home.png">
<meta name="theme-color" content="#0a0a0f">
${FONTS}
${ld(breadcrumb)}
<style>
:root{color-scheme:dark;--bg:#0a0a0f;--accent:#6f9bff;--text:#eef1fa;--muted:#aebbe6;--dim:#9aa6cf}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Newsreader',Georgia,serif;font-size:19px;line-height:1.75;overflow-x:hidden}
${STARFIELD}
.wrap{position:relative;z-index:1;max-width:680px;margin:0 auto;padding:40px 22px 90px}
a{color:#9fbcff}
nav{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim);margin-bottom:34px}
nav a{color:var(--muted);text-decoration:none}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(32px,5.4vw,46px);line-height:1.12;margin:0 0 14px;font-weight:800;letter-spacing:-.5px;padding-bottom:.06em}
.lede{color:var(--muted);font-size:21px;margin:0 0 36px}
h2{font-family:'Fraunces',Georgia,serif;font-size:25px;font-weight:700;margin:40px 0 12px;letter-spacing:-.3px}
p{margin:0 0 20px}
ul{padding-left:22px;margin:0 0 20px}
li{margin:0 0 12px}
strong{color:#fff}
.principle{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
footer{margin-top:50px;padding-top:24px;border-top:1px solid #1c2138;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:var(--dim)}
</style>
</head>
<body>
<div class="stars"></div><div class="glow"></div>
<div class="wrap">
<nav><a href="/">Space Quotes</a> &nbsp;/&nbsp; Terms</nav>
<h1>Terms &amp; disclaimer</h1>
<p class="lede">Space Quotes is a personal project. Read it for what it is: a quick, sourced look at the public record of space regulation, not advice you should act on.</p>

<h2>Provided as is</h2>
<p>This site is provided <strong>"as is" and "as available," with no warranties of any kind</strong>, express or implied, including any warranty of accuracy, completeness, fitness for a particular purpose, or uninterrupted availability.</p>

<h2>Informational use only</h2>
<p>The space facts, quotes and regulatory tidbits here are for <strong>informational and educational purposes only</strong>. They may contain errors, omissions or things that are out of date, and they must not be relied upon for legal, business, compliance, investment or any other decision. Always verify against the primary source before you act on anything you read here.</p>

<h2>No liability</h2>
<p>To the maximum extent permitted by law, the operator of this site is <strong>not liable for any damages</strong> of any kind arising from your use of the site or your reliance on its content.</p>

<h2>Quotes and attribution</h2>
<p>Quotes are pulled from primary filings and attributed to their authors. They are believed accurate but are <strong>provided without guarantee</strong>; where a line matters to you, read it in the original document.</p>

<h2>Privacy</h2>
<p>Space Quotes <strong>collects no personal data and sets no cookies</strong>. There are no forms, no analytics and no tracking.</p>

<h2>Contact</h2>
<p>Space Quotes is written by <strong>Anthony Caracappa</strong> using tools from <a href="${sentinelUrl('terms_byline')}">viventine.com</a>. Questions or corrections? Reach out via <a href="${VIVENTINE}">viventine.com</a> or see the <a href="/about/">about page</a>.</p>

<footer><a href="/tidbits/">Browse the tidbits →</a> · spacequotes.org</footer>
</div>
</body>
</html>
`;
}

// ---------- feeds ----------
function feedXml(items) {
  const now = new Date().toUTCString();
  const entries = items
    .map((it) => {
      const url = `${SITE}/tidbits/${it.fm.slug}/`;
      const pub = new Date(`${it.fm.date}T09:00:00Z`).toUTCString();
      return `    <item>
      <title>${esc(it.fm.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pub}</pubDate>
      <description>${esc(teaser(it.body))}</description>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Space Quotes — Tidbits</title>
    <link>${SITE}/tidbits/</link>
    <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Sourced tidbits from real FCC, ITU and FAA space filings, each built around a quotable line from the filing.</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
${entries}
  </channel>
</rss>
`;
}

function sitemap(items, hubPaths = []) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, pri: "1.0", freq: "daily", lastmod: today },
    { loc: `${SITE}/tidbits/`, pri: "0.9", freq: "daily", lastmod: today },
    ...hubPaths.map((p) => ({ loc: `${SITE}${p}`, pri: "0.7", freq: "weekly", lastmod: today })),
    ...items.map((it) => ({ loc: `${SITE}/tidbits/${it.fm.slug}/`, pri: "0.8", freq: "monthly", lastmod: it.fm.date })),
  ];
  const body = urls
    .map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// ---------- build ----------
if (!existsSync(CONTENT)) {
  console.error(`No content dir at ${CONTENT}. Approve a tidbit by copying out/<slug>/draft.md there.`);
  process.exit(1);
}
const items = readdirSync(CONTENT)
  .filter((f) => f.endsWith(".md"))
  .map((f) => parse(readFileSync(join(CONTENT, f), "utf8"), join(CONTENT, f)))
  .sort((a, b) => (a.fm.date < b.fm.date ? 1 : -1));

// ---- group by tag/docket first, so tidbit pages know which hubs actually exist ----
const byTag = {};
const byDocket = {};
for (const it of items) {
  for (const t of Array.isArray(it.fm.tags) ? it.fm.tags : it.fm.tags ? [it.fm.tags] : []) (byTag[t] ||= []).push(it);
  if (it.docket) (byDocket[it.docket] ||= []).push(it);
}
// A hub is "promoted" (gets its own page + inbound links) only at HUB_MIN+ tidbits.
PROMOTED_TAGS = new Set(Object.keys(byTag).filter((t) => byTag[t].length >= HUB_MIN));
PROMOTED_DOCKETS = new Set(Object.keys(byDocket).filter((d) => byDocket[d].length >= HUB_MIN));

const relatedFor = (it) => {
  const same = items.filter((o) => o.fm.slug !== it.fm.slug && o.docket && o.docket === it.docket);
  const others = items.filter((o) => o.fm.slug !== it.fm.slug && !same.includes(o));
  return [...same, ...others].slice(0, 3);
};

ogHome();
for (const it of items) {
  const ogImage = ogCard(it.fm.slug, it.fm, it.pull);
  const desc = metaDescription(it.body);
  const html = page(it.fm, bodyToHtml(it.body), it.pull, ogImage, desc, it.mtime, relatedFor(it), it.docket, it.faq);
  const dir = join(ROOT, "tidbits", it.fm.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  console.log(`  tidbits/${it.fm.slug}/`);
}

// ---- hub-and-spoke: topic + docket hubs (only promoted ones) and their indexes ----
const hubUrls = [];
const writeHub = (dir, slug, html) => {
  const d = join(ROOT, dir, slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "index.html"), html);
  hubUrls.push(`/${dir}/${slug}/`);
};
// Remove any previously-generated hub dirs that no longer qualify (kills stale thin pages).
const pruneHubs = (dir, keep) => {
  const base = join(ROOT, dir);
  if (!existsSync(base)) return;
  for (const name of readdirSync(base)) {
    if (name === "index.html") continue;
    if (!keep.has(name)) rmSync(join(base, name), { recursive: true, force: true });
  }
};
for (const [tag, its] of Object.entries(byTag)) if (its.length >= HUB_MIN) writeHub("topics", tag, topicHub(tag, humanizeTag(tag), its));
for (const [dk, its] of Object.entries(byDocket)) if (its.length >= HUB_MIN) writeHub("dockets", dk, docketHub(dk, its));
pruneHubs("topics", PROMOTED_TAGS);
pruneHubs("dockets", PROMOTED_DOCKETS);

const topicEntries = Object.entries(byTag).filter(([, its]) => its.length >= HUB_MIN).map(([slug, its]) => ({ slug, label: humanizeTag(slug), n: its.length })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
const docketEntries = Object.entries(byDocket).filter(([, its]) => its.length >= HUB_MIN).map(([slug, its]) => ({ slug, label: `Docket ${slug}`, sub: docketLabel(slug), n: its.length })).sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug));
mkdirSync(join(ROOT, "topics"), { recursive: true });
mkdirSync(join(ROOT, "dockets"), { recursive: true });
writeFileSync(join(ROOT, "topics", "index.html"), hubIndex("topics", topicEntries));
writeFileSync(join(ROOT, "dockets", "index.html"), hubIndex("dockets", docketEntries));
const hubIndexUrls = ["/topics/", "/dockets/"];

mkdirSync(join(ROOT, "tidbits"), { recursive: true });
mkdirSync(join(ROOT, "about"), { recursive: true });
writeFileSync(join(ROOT, "tidbits", "index.html"), feedPage(items));
writeFileSync(join(ROOT, "about", "index.html"), aboutPage());
mkdirSync(join(ROOT, "terms"), { recursive: true });
writeFileSync(join(ROOT, "terms", "index.html"), termsPage());
writeFileSync(join(ROOT, "index.html"), homePage(items, topicEntries, docketEntries));
writeFileSync(join(ROOT, "feed.xml"), feedXml(items));
writeFileSync(join(ROOT, "sitemap.xml"), sitemap(items, ["/about/", "/terms/", ...hubIndexUrls, ...hubUrls]));
console.log(`built homepage + ${items.length} tidbit(s) + ${PROMOTED_TAGS.size} topic + ${PROMOTED_DOCKETS.size} docket hubs (gated at ${HUB_MIN}+) + feed + RSS + sitemap`);
