# Space Quotes — Authority, SEO & Interaction Strategy

The goal is durable **domain authority** for spacequotes.org, earned through **value** and
**authenticity**. The engine (Orbit Sentinel) + the tidbit format give us a defensible moat:
we publish *primary-sourced, independently-verified* dispatches from space regulation that
almost no one else is turning into readable, shareable content. This doc is how we compound
that into authority.

## 1. The moat: why this earns authority (E-E-A-T)
Google's quality framework rewards Experience, Expertise, Authoritativeness, Trust. Our
structural advantages:
- **Primary sourcing.** Every tidbit links to the original FCC/ITU/FAA document. We are a
  *citable secondary source*, not a content farm. Citability → backlinks → authority.
- **Verification.** Each claim is checked against the source by an independent pass before
  publish (our anti-hallucination gate). This is a real trust signal we should make visible
  (the "Verified, not generated" band) and never compromise — one fabricated filing erases
  the moat.
- **A unique angle.** The quote pairing makes dry regulation human and shareable. Nobody else
  occupies "space policy × timeless meaning."

**Implication:** never trade accuracy for volume. Authority is the asset; a single hallucinated
claim is an existential withdrawal from it.

## 2. Content strategy
- **Cadence:** few per week, high quality (decided). Consistency > burst. Each is evergreen-ish
  (a real filing, dated) and accrues over time.
- **The repeatable unit:** headline → sourced lede → **Why it matters** (stakes/players) →
  paired quote → bridge → primary-source links. Analytical, ~150–250 words, always verified.
- **Topic clusters (the SEO backbone — highest-leverage next build):** group tidbits into hubs:
  - **Docket hubs** — `/dockets/25-201/` listing every tidbit + context for that proceeding.
  - **Theme hubs** — `/topics/direct-to-cell/`, `/topics/orbital-debris/`,
    `/topics/spectrum-sharing/`. These target head terms; individual tidbits target long-tail
    (docket numbers, company names). Hub-and-spoke internal linking is what turns a flat list
    of pages into a rankable cluster. (Related-tidbit links shipped; full hub pages are the
    next build.)
- **Depth:** push tidbit bodies toward 350–500 words (add "What's in the filing" / "Who's
  involved" / "What's next") so they rank beyond the exact docket string — without ever adding
  an unverified sentence.

## 3. Technical SEO (status + backlog)
**Shipped:** unique titles/descriptions, canonical, `max-image-preview:large`; WebSite +
Organization (with logo) + ItemList; per-tidbit Article (ImageObject) + BreadcrumbList; real
RSS at `/feed.xml`; OG/Twitter cards (per-tidbit + brand home card); sitemap with lastmod;
semantic headings (incl. "Why it matters" as `<h2>`); fast static, mobile-first, reduced-motion.
**Hub-and-spoke architecture** — `/topics/<tag>/` and `/dockets/<num>/` hub pages with
BreadcrumbList + ItemList schema, `/topics/` and `/dockets/` index pages, "Filed under" chips
on every tidbit (→ hubs), a "Browse by topic" section on the homepage, and all hubs in the
sitemap. This is the cluster backbone that lets long-tail tidbits and head-term hubs reinforce
each other.

Also shipped: **About / methodology page** (`/about/`, AboutPage + Organization schema) and
**FAQPage schema** on tidbits (verified Q&As, visible + structured).

**Backlog (prioritized):**
1. **Named author / editorial entity** + `sameAs` social profiles on Organization → entity
   authority + knowledge panel eligibility.
2. **Self-host fonts** (drop the Google Fonts request) for privacy + LCP.
3. **Deeper bodies** (§2) — push tidbits toward 350–500 words without unverified claims.
6. Submit sitemap to Search Console + Bing Webmaster; monitor coverage.

## 4. Distribution & interaction
Authority needs reach; reach needs shareable artifacts. We have them.
- **Share cards as the product.** The 1200×630 OG card (quote + filing + wordmark) is built to
  stop a scroll and carry the domain. Every tidbit is born shareable.
- **The quote hook.** Lead social posts with the quote ↔ filing tension ("Tsiolkovsky said the
  Earth is our cradle. Here's AST telling the FCC how its satellites will fall out of it.").
  This is the emotional payload that earns shares a dry filing never would.
- **Channels:** X/Bluesky/LinkedIn (space-policy + space-enthusiast communities), the RSS feed
  (Discover/aggregators/syndication), and eventually a low-frequency email digest.
- **Interaction loops:**
  - On-site: related tidbits + hubs keep readers moving (depth, dwell, internal authority flow).
  - A "browse by docket/topic" experience invites exploration.
  - Light, optional: per-tidbit "discuss on X" links; a "get the weekly tidbit" capture.
- **Be where the citations happen.** Space journalists, policy wonks, and operators discuss
  these dockets. Being the cleanest, most-linkable summary makes us the natural citation —
  which is the backlink flywheel.

## 5. Link-building / authority flywheel
1. Publish a verified, genuinely useful tidbit on a live docket.
2. Distribute via the quote-hook share card to the people who care about that docket.
3. Some cite/link it (because it's accurate and links to primary sources).
4. Those links lift domain authority → tidbits rank → more organic readers → more citations.
The accelerant is **trust**: the more reliably accurate we are, the more freely people link.

## 6. Metrics
- **Authority:** referring domains, branded search volume, Search Console impressions/clicks.
- **Content:** indexed pages, avg. position for target clusters (docket/topic terms), CTR.
- **Engagement:** pages/session, scroll depth, related-tidbit clicks, RSS subs, social shares.
- **Pipeline health:** publish cadence, verification pass-rate (and that it's never bypassed).

## 7. Next builds (recommended order)
1. ~~Topic/docket hub pages (cluster architecture)~~ — **shipped.**
2. ~~About/methodology page~~ — **shipped.** (Named editorial entity + `sameAs` still open.)
3. ~~FAQ schema~~ — **shipped.** Deeper 350–500-word bodies still open.
4. **Email digest + social automation** off the existing share cards — distribution.
5. **Go live** (merge → push) and submit the sitemap to Search Console.
6. Keep the content engine running: a few verified tidbits per week, no exceptions to the gate.
