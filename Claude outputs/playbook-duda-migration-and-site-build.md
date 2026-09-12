# Website Creation & DUDA Migration Playbook

**Updated 2026-09-12 (v2)** — merges three things that were previously separate documents/notes: the original DUDA extraction prompt, the prerequisite checklist you just sent (Hostinger site creation + WP Sites connection), and the build-discipline gates added after build-1 repeated the build-6/Oxygen "started writing pages with no template or plan" failure. **This is now the one file to use — the copy you pasted and the one I sent earlier today are both superseded by this version; safe to delete both.**

**How to use this:** copy the relevant phase blocks into Noah's task for a given site, replacing `{{SITE_NAME}}` / `{{DOMAIN}}` / `{{BUILD_SITE}}` as needed. It also works pasted into Admin → Playbooks scoped to `wp-sites` (or `*` if you want it to reach the Duda connector's own tasks too) — your call.

Target stack throughout: **Gutenberg + Kadence Blocks (Kadence Pro), Contact Form 7 for forms.** Oxygen and Fluent Forms are retired fleet-wide — anywhere an older note says either of those, this version corrects it.

---

## Phase -1 — Prerequisites (human, before Noah touches anything)

1. **The WordPress site itself must exist in Hostinger** — Ryan, Wayne, or Chad creates it.
2. **The site must be added in WP Sites** so Noah can actually reach it — this requires generating an Application Password on the site and running a quick connectivity test. Owner: Ryan.

Nothing below starts until both of these are done. If Noah is asked to migrate a site and either step hasn't happened, that's a "come back to me" moment, not something to work around.

## Phase 0 — Before touching the build site at all (hard gate)

- **If the build site already has content on it** (a previous attempt, a stale template, anything) — stop and get an explicit decision before writing anything: reset it clean and rebuild in place, or use a different, currently-empty build slot and leave the old one for reference. Don't assume either way; this was previously decided ad hoc mid-task and cost a full redo.
- **Do not call `start_mission` or write a single real content page until Phases 1–6 below are complete.** A fast build with no upfront plan is exactly what produced both the Oxygen/build-6 failure and the first Kadence/build-1 attempt.

---

## Phase 1 — Structured inventory (API)

Call, in order, against the source DUDA site:
1. `get_site_details` — confirm the site, get `canonical_url`, `publish_status`, and `preview_site_url`.
   - `PUBLISHED` → use the live `canonical_url` for Phase 2.
   - `NOT_PUBLISHED_YET` / `UNPUBLISHED` → use `preview_site_url` instead — it works unpublished and carries its own signed auth token. Don't strip or modify that URL.
2. `list_pages` — every page's path, title, and SEO block. This is the exact page list for Phase 2 — visit every path returned here, nothing more, nothing less.
3. `get_site_theme` — the full color palette (note each color's semantic `label`, e.g. "Accent Gold") and typography per heading level, button styles, and section spacing. Record verbatim — this maps directly onto Kadence's **Global Palette** and **Global Typography** settings (set once site-wide in Appearance → Customize, referenced by every block via `var(--global-paletteN)` — never hardcode a hex/px value per block).
4. `get_content_library` — business name, description, category, tone of voice, phones, emails, physical address. Source of truth for contact info — more reliable than scraping a Contact page.
5. If the site has a blog, `list_blog_posts` then `get_blog_post` per post — blog posts **do** return full content through the API, unlike regular pages. Pull them here, don't re-scrape in the browser.
6. If `store_status` isn't `NONE` — flag it in the manifest's `flags` array and stop there. E-commerce migration is a separate task (WooCommerce mapping), not a copy-paste.
7. If `booking.status` isn't `NOT_INSTALLED` — same treatment, flag and skip.

## Phase 2 — Live page content & images (browser)

For every path from `list_pages`, open `{base_url}/{path}` and extract, top to bottom:
- Every heading/paragraph, tagged with its section (hero, about block, staff grid, service times, etc. — your judgment on boundaries, keep the order).
- Every image: full-resolution `src`, `alt` text if present, and its role (hero background, staff headshot, logo, gallery item, icon). DUDA serves off `irp.cdn-website.com` — grab the direct file URL, not a lazy-load placeholder.
- Embedded video/livestream (YouTube, Vimeo, Facebook Live) — capture the embed URL, not a screenshot.
- Navigation: header and footer menu items (label + target), in order.
- Any form: every field's label + type, and the submit button text. Don't replicate DUDA's form backend — this just tells the rebuild what fields to recreate **in Contact Form 7** (the fleet-standard forms plugin — not Fluent Forms).
- Any interactive widget (accordion, tabs, slider/carousel, map embed) — note type + content; the rebuild will pick a **Kadence-side** equivalent.

Take one full-page screenshot per page as a visual fallback reference (layout intent, spacing, background pattern) — not the primary record.

## Phase 3 — Image handling

Download every image URL from Phase 2 into this site's folder in the workspace file library — don't leave images as remote DUDA URLs in the manifest. Name predictably: `{page-slug}-{role}-{n}.{ext}` (e.g. `home-hero-1.jpg`, `about-staff-2.jpg`). Record saved filename, original alt text, and pixel dimensions.

## Phase 4 — Output manifest

One JSON file per site, saved to the workspace file library as `{{SITE_NAME}}-extraction.json`:

```json
{
  "source": {
    "duda_site_name": "eb62bd61",
    "duda_domain": "yourtown-community-church.multiscreensite.com",
    "extraction_date": "2026-09-12"
  },
  "business": {
    "name": "Yourtown Community Church",
    "description": "...",
    "category": "Church",
    "tone_of_voice": "CONVERSATIONAL",
    "phones": [{"number": "...", "label": "Main"}],
    "emails": [{"address": "...", "label": "Main"}],
    "address": "123 Maple Street, Yourtown, ON, Canada, A1B 2C3"
  },
  "design_tokens": {
    "colors": [{"label": "Accent Gold", "value": "rgba(201,154,59,1)"}],
    "typography": { "h1": {"font_family": "Lora", "font_size": "56px"}, "paragraph": {"..."} },
    "buttons": {"primary": {"..."}, "secondary": {"..."}}
  },
  "navigation": {
    "header": [{"label": "About Us", "path": "about"}],
    "footer": [{"..."}]
  },
  "pages": [
    {
      "path": "home",
      "title": "Home",
      "seo": {"title": "...", "description": "..."},
      "sections": [
        {
          "type": "hero",
          "heading": "Welcome Home Sunday",
          "body_text": "...",
          "images": [{"file": "home-hero-1.jpg", "alt": "...", "role": "background"}],
          "repeats": false
        }
      ],
      "forms": [{"fields": [{"label": "Your Name", "type": "text"}], "submit_label": "Send"}],
      "embeds": [{"type": "youtube", "url": "..."}]
    }
  ],
  "blog_posts": [{"title": "...", "content": "...", "published_date": "..."}],
  "flags": [
    "store_status: BASIC — e-commerce present, not extracted, needs separate handling",
    "booking installed — not extracted, needs separate handling"
  ]
}
```

The `"repeats": true/false` flag on each section marks anything that is a list of similar items (staff members, sermons, events, service times, testimonials). Phase 6 uses this flag to decide what needs a dynamic/collection treatment instead of static per-page text.

## Phase 5 — Completeness gate (sanity check before Phase 0's decision is acted on)

Before this counts as "all data from the old site," confirm:
- Page count in the manifest matches `list_pages`' count exactly.
- Every image referenced in a section has a corresponding downloaded file — no dangling remote URLs.
- The `flags` array captures anything skipped (store, booking, an unidentified embed, a non-standard font from `get_site_theme`).
- Every repeating-list section is marked `"repeats": true`.

**This manifest is the completeness gate for Phase 0** — the rebuild does not start until every item above is true. A partial extraction ("Phase 1 worked, so I'll start building") produces a site with a design system and holes where the content should be — this already happened once.

---

## Phase 6 — Build the shared page template FIRST

Do this before writing a single real content page, on the reset/clean build site.

1. Apply the site's actual extracted design tokens (not generic placeholders) to Kadence's **Global Palette** and **Global Typography** settings.
2. Build one clearly-marked, non-public template page (e.g. `_TEMPLATE`) demonstrating every recurring layout pattern the site will need: hero, text+image split, staff/team grid, service-times block, sermon/event list, testimonial/quote block, image gallery, CTA banner, contact/form section, footer pattern. Pull the actual set of patterns needed from the `sections` arrays across all pages in the manifest — don't guess a generic list.
3. Use consistent block-to-content mapping across the template and every later page: a `sections[]` entry becomes a **Row Layout / Column block** pair; `heading` → an **Advanced Heading** block; `body_text` → a **Paragraph** block; `images` → a **Kadence Image** or **Gallery** block. Every new block needs its own freshly generated `uniqueID` (duplicate IDs across blocks collide in the compiled CSS) — and every write needs a cache/recompile trigger afterward so Kadence regenerates its block CSS (don't trust a 200 response alone; verify the page actually renders correctly).
4. For every section flagged `"repeats": true`, decide the dynamic approach **now, once** — not per-page later: an ACF field group + Kadence Dynamic Content tag, or an existing CPT where one already fits (The Events Calendar for events; Contact Form 7 for forms). Hand-typed, repeated static text for something the source treated as a list is the anti-pattern to avoid.
5. Save a short **design guide** to the file library alongside the template: which Kadence block covers each pattern, which global tokens are in use, and the dynamic-content decisions from step 4. Every page build in Phase 7 references this guide instead of re-deciding block choices from scratch.
6. **Hard stop:** visually inspect the template at desktop, tablet, and mobile widths and get it explicitly signed off (flag it for a human check-in here — the template sets the pattern for the entire site, so it's worth a pause even though individual pages in Phase 7 don't each need one) before any real content page is built from it. If the template needs revision, revise the template — don't let an approved-elsewhere pattern drift page by page.

## Phase 7 — Build each page, one at a time, plan before build

For every page in the manifest (home and top-nav pages first is a reasonable order):

1. **Analyze** — re-read that page's `sections` from the Phase 1–4 manifest, and the original live Duda page/screenshot if anything is ambiguous.
2. **Plan** — before touching WordPress, note which Kadence block or dynamic component each section maps to, referencing the Phase 6 design guide. A section that doesn't cleanly match an existing template pattern is a signal to go back and extend the template, not to improvise a one-off block choice mid-page.
3. **Build** — implement the page per the plan.
4. **Inspect** — `fetch_url`/browse the live page at desktop, tablet, and mobile widths. Compare against the plan and the original Duda page. Header+footer-only or a visibly broken section means it isn't done.
5. **Sign off** — mark the page done in the mission/task notes before starting the next page. Don't queue several pages to "inspect later" — one page fully signed off, then the next.

## Phase 8 — Final site-wide pass

Once every page is individually signed off: recheck cross-page consistency (nav menus, footer, any sitewide banner/embed), purge cache (`wp_cache_flush`), and do one more full read-through of the finished site before reporting the migration complete.

---

## What NOT to do (this is the second time it happened — being explicit)

- Don't call `start_mission` or begin real content writes before Phases -1–6 are done.
- Don't skip the template phase because a page "looks simple" — that's the exact thought that skipped it last time.
- Don't batch multiple pages between visual inspections.
- Don't hand-type a repeating list (sermons, events, staff, service times) that the manifest flagged `"repeats": true` — that's a dynamic/collection decision made once in Phase 6, not a per-page judgment call.
- Don't proceed past Phase 5 with an incomplete manifest just because "most of it" extracted successfully.
- Don't reach for Fluent Forms or an "Oxygen-side" widget equivalent — this stack is Contact Form 7 and Kadence Blocks, full stop.

---

## A few things worth knowing when running this across many sites

- `list_sites` is paginated (default 25, max 200 per page) — page through with `offset`/`next_offset` rather than assuming one call gets everything.
- Unpublished sites extract fine — `preview_site_url` carries its own signed token, no need to publish first.
- Phases 1–5 are read-only against DUDA and safe to run unattended at scale once spot-checked on 2–3 sites.
- Phase 1 (API) is reliable across sites; Phase 2 (browser crawl) depends on how consistently each site's Duda editor laid out sections, and will need more per-site judgment.
- Everything from Phase 6 onward should be identical process regardless of which site is being migrated — that consistency is the point of writing it down once here instead of re-deciding it per site.
