# Artivio Noah — Duda → WordPress Migration Capability (Design)

**Status:** Design agreed with Ryan 2026-09-25, refined same day with a human-review checkpoint, all five original open items finalized same day, and **Part 1 handed to Cline 2026-09-25** (schema + Phase 1 extraction). See "Build status" at the bottom.

## Goal

A capability inside Artivio (Noah's platform) that migrates a client's existing Duda website into a new WordPress site: extract all content (pages, blog posts, structured collections, images, business info), then rebuild it in WordPress/Divi with a **new** design — not a pixel clone of the Duda layout.

**Decisions locked with Ryan:**
- Design approach: map migrated content into Noah's **existing Divi section templates** (hero, blurbs, CTA, etc. — the same vocabulary it already uses building pages live in site chat), not a bespoke per-page design and not "pick a WP theme first."
- Build scope: a **generic, reusable Artivio capability** from day one — any client's Duda site, not built against one example client and generalized later. Consistent with the standing principle of building platform integrations generically.
- v1 content scope: **pages + images + business info, blog posts, and Collections** (team/products/events/etc.). **Store and bookings are explicitly out of v1** — meaningfully more complex (variants, inventory, calendars) and deferred until a client actually needs it.

## Revision: human review checkpoint

Ryan's past migration attempts "never went well" — root cause: going straight from raw extraction to rebuilt WordPress pages with no human-reviewable checkpoint in between. Fix: Phase 1's output is a **structured, human-readable Markdown file set** ("the migration dashboard" content) that Ryan/the client review and approve before Phase 2/3 touch WordPress at all.

## Critical constraint discovered (this changes the design)

Checked Duda's actual MCP/API surface before designing. For **classic Duda sites** (the drag-and-drop editor — the vast majority of existing customer sites), **there is no API that returns real page content** (text blocks, layout, images-in-place). `list_pages` only returns metadata (title, path, SEO, UUID).

What Duda's API *does* give cleanly:
- `list_blog_posts` + `get_blog_post` — full post content, clean, no scraping needed.
- `get_collections` — structured dynamic data (Team_Members, Products, Events, etc.), full field/row data.
- `get_content_library` — business info: name, description, logo, hours, address, socials, geo.
- `get_site_theme` — global color palette + typography (used for the current-design documentation below).
- `list_pages` / `get_site_details` — page inventory and site metadata only.

There is a separate `vibe_read_files` / `vibe_list_files` path that returns actual source code, but **only for sites built on Duda's newer "Vibe" code-based builder** — a small, different population of sites. **v1 targets classic Duda only.**

**Conclusion: page body content must be extracted by fetching each page's published live URL and parsing the rendered HTML** (headings, paragraphs, image src+alt, links/CTAs, nav structure).

## Architecture: three phases, not one live chat turn, with a human gate after Phase 1

A real migration (dozens of pages + a blog archive + collections + media) will blow straight through the limits that already gate Noah's live site-chat turns (`SITE_TURN_MAX_ITERATIONS = 28`, `SITE_TURN_WALL_CLOCK_MS = 6 * 60_000` — see `src/libs/sitechat/turns.ts`). This has to run as a **background job with checkpoints**, structured as three phases plus an explicit review gate.

### Phase 1 — Extract & Document (Duda → a reviewable Markdown file set)

```
migration/<site>/
  00-overview.md              ← the file a human reads: page list, blog list (by date), review checklist
  pages/<slug>.md             ← one file per page, structured
  posts/<date>-<slug>.md      ← one file per blog post, structured
  design/current-design.md    ← brand-identity checklist, filled in
  design/new-design-brief.md  ← new-design direction
  media/                      ← downloaded images + manifest (old URL → local file → suggested WP alt text)
```

Extraction steps:
1. `list_pages` → page inventory (path, title, SEO, UUID).
2. For each page: fetch the published URL, parse the HTML into structure (headings, paragraph text, image src/alt, links/CTAs, nav structure once from header/footer) → write `pages/<slug>.md`.
3. `list_blog_posts` (paginated) + `get_blog_post` per post → write `posts/<date>-<slug>.md`, one per post, by date.
4. `get_collections` (list, then per-collection detail) → structured rows for team/products/events/etc.
5. `get_content_library` → business name, description, logo, hours, address, socials — folded into `00-overview.md`/current-design.md.
6. Every image URL touched anywhere gets downloaded once (dedup by hash) into `media/`, surfaced in Artivio's dashboard before Phase 3 pushes them into the WP media library.

**Page file template** (`pages/<slug>.md`):
```markdown
---
source_path: /about-us
target_slug: about-us
page_type: about        # home | about | service | contact | ministry | generic
title: About Us
seo_title: ...
seo_description: ...
status: extracted       # extracted | reviewed | mapped | built
---

# About Us

## Hero
**Heading:** ...
**Subheading:** ...
**Image:** media/about-hero.jpg (alt: "...")
**CTA:** "Plan a Visit" → /visit

## Section: Our Story
...body text...

## Notes for rebuild
<!-- anything ambiguous the reviewer should resolve -->
```

**Blog post file template** (`posts/2026-03-02-easter-service-times.md`):
```markdown
---
date: 2026-03-02
author: ...
tags: [events, easter]
featured_image: media/easter-2026.jpg
status: extracted
---

# Easter Service Times Announced
...full body...
```

**Overview file** (`00-overview.md`): a table of all pages with status, a table of all blog posts by date with status, links to the two design files, and a literal checklist:
```markdown
## Review status
- [ ] Pages reviewed
- [ ] Blog posts reviewed
- [ ] Images reviewed
- [ ] Current design documented
- [ ] New design approved
```
that **gates** the WordPress build. Nothing proceeds to Phase 2 until this is checked off.

Rate-limit/politeness rule for the crawl: max 2–3 concurrent requests, ~500ms–1s delay between requests to the same host, respect `robots.txt`, identify with a real descriptive User-Agent, hard back-off on any 429/503. Conservative on purpose — this is a live customer site, and we've separately seen firsthand (the build9 LiteSpeed-cache investigation) how easily these hosting setups get twitchy under unusual traffic.

#### `design/current-design.md` — brand-identity checklist

- **Logo & marks** — every variant in use (full-color, reversed/white, favicon) and where each appears today
- **Color palette** — exact values via `get_site_theme` (not eyeballed), *and* which color plays which role (CTA vs. heading vs. background)
- **Typography** — heading/body font families + general personality
- **Imagery style** — real photos vs. stock, warm vs. cool tone, people-forward vs. place-forward
- **Voice & tone** — a copy sample as reference (formal vs. warm/conversational)
- **Recurring signature elements** — anything regulars would notice missing (nav labels like "Sermons"/"Give", a service-times widget, etc.)
- **Required footer/legal marks** — denominational affiliation badges, copyright text, accreditation marks
- **Non-visual continuity items** — analytics IDs, tracking pixels, embedded widgets that need to be re-added

#### `design/new-design-brief.md` — capturing the new direction (better than "send a reference URL")

1. **Short forced-choice questionnaire first** (5–6 questions pulled from the brand checklist above: modern/minimal vs. warm/traditional, bold color vs. muted, photo-heavy vs. icon/illustration-heavy, spacious vs. content-dense, plus "anything from the old site that must not change").
2. **Reference URL(s)/images stay optional** — additional signal layered on the questionnaire, never the sole instruction.
3. **Show, don't just ask — as real Divi drafts, not static image comps.** Noah builds 2–3 directions of just the homepage hero + one section as actual **unpublished draft pages on the destination WP site**, using the same page-building capability it already has live in site chat — not a separate static-image mockup pipeline. Trade-off made deliberately: costs more agent time per option than a flat image would, but guarantees what the client approves is exactly what Divi can build (no "the picture looked nicer than reality" gap), and the approved draft becomes the literal starting template for the rest of the build rather than being thrown away.
4. **Placement: Artivio Dashboard, ChurchWeb workspace** (confirmed by Ryan) — not inside Noah chat. The whole migration surface (file browser, image gallery, the questionnaire, the draft-mockup gallery) lives here; a dashboard gives room for this that a chat UI doesn't.

Output: concrete, usable parameters ("warm amber accent, modern serif headings, real-people photography, spacious layout") plus the chosen/approved Divi draft, both feeding Phase 2 directly.

### → Human review gate

Ryan/the client review `00-overview.md` and drill into any page/post/design file needing a fix, in the Artivio Dashboard / ChurchWeb workspace. Nothing in Phase 2/3 runs until the overview checklist is fully checked off. This is the fix for past migrations "never going well."

### Phase 2 — Map (reviewed Markdown → a WordPress build plan)

- **Pages:** classify each reviewed page by type (home / about / service-or-ministry / contact / generic — see fixed template set below), slot content into the matching Divi section template from Noah's existing vocabulary. Content-into-template, not layout-cloning — Duda's box positions don't map to Divi's structure and shouldn't be preserved.
- **Blog posts:** near 1:1 — title/body/featured image/tags → a WP post.
- **Collections:**
  - **Events** → map directly into **The Events Calendar** (already installed on build9) as native event entries — not a generic CPT.
  - **Giving/donation-related content** → point at **GiveWP** (already installed) rather than a flat content page.
  - Everything else: >~6 rows or content the client will keep updating (products, job openings) → **WP custom post type + ACF fields** (ACF confirmed installed on build9), rendered via a Divi dynamic-content/listing module. Small/static (e.g., 3–4 fixed team bios) → flattened into static Divi modules directly.
- **Business info:** feeds WP site-wide settings/footer/schema.org, matching existing `site.label`/`site.builder` conventions in the site-chat system prompt.

**Page-type classification approach:** hybrid — cheap heuristics first (URL slug/title keyword matching) as a fast guess, then an LLM pass confirms or overrides. **Fixed v1 template set** (kept small and fixed on purpose, for predictable output):
- **Home** — hero + highlights/services blurbs + events teaser + sermons teaser + CTA
- **About** — hero + story/mission + leadership/staff + CTA
- **Generic content page** — hero + body sections (as many as needed) + CTA
- **Contact** — hero + info/map + service times + form

**Output:** a per-page/per-post/per-collection build plan — still auditable before any live WordPress writes.

### Phase 3 — Build (execute the plan via Noah's existing WP/Divi tools)

Reuses the same `wp-sites` / `diviops-*` tool namespace already wired into Noah's per-site toolset (`buildSiteChatToolset`) — no parallel WP-writing code path. Runs as a background job:
- One page/post/collection-row at a time.
- Checkpointed progress via the `migration_jobs`/`migration_items` schema (see Part 1 build) so a crash/timeout resumes rather than restarting.
- Progress surfaced back to the dashboard ("Migrated 12/45 pages, 8 blog posts, 1 of 2 collections...").
- Media uploaded to the WP media library once per unique file (dedup from Phase 1's manifest).

## Where this lives in Artivio's architecture

Not a tool Noah calls mid-conversation (a full migration is a bulk job, not a chat action). A top-level capability — "Tools → Migrate a site" — in the **Artivio Dashboard, ChurchWeb workspace**: source a connected Duda site, destination a connected WP site. This *is* the "migration dashboard": overview, page/post list, image gallery, the two design files, and the Divi-draft mockup gallery all live here, with the review checklist gating the build. Phase 3 reuses existing WP tool functions rather than duplicating WordPress-writing logic in a second code path.

## Explicitly out of scope for v1

- Duda Store / e-commerce (products-as-inventory, variants, orders).
- Duda Bookings/appointments.
- Duda "Vibe" (code-based) sites — different extraction path (`vibe_read_files`), separate design if ever needed.
- Pixel-level layout replication — explicitly not the goal.

## Build status

- **Part 1 of 3 — handed to Cline 2026-09-25**, prompt: `cline-prompt-duda-wp-migration-part1-foundation.md`. Scope: check/confirm Duda API credentials setup, `migration_jobs`/`migration_items` schema + hand-written SQL migration, the Phase 1 extraction module (Duda → the Markdown file set, with crawl politeness rules), a minimal entry point to trigger a job, and a CLAUDE.md changelog entry. Ends with push to `origin/main`.
- **Part 2 (not started)** — the mapping/classification engine (Phase 2): page-type classification, slotting content into the fixed Divi template set, Collections routing (Events Calendar / GiveWP / CPT+ACF).
- **Part 3 (not started)** — Phase 3 build execution, the new-design questionnaire + Divi-draft mockup flow, and the dashboard UI (file browser, image gallery, mockup gallery, review checklist) in the Artivio Dashboard / ChurchWeb workspace.
