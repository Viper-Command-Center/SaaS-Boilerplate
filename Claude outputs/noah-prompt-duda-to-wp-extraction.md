# Task prompt for Noah — DUDA site content extraction (pre-migration)

**How to use this:** copy the block below into Noah's task for each site, replacing `{{SITE_NAME}}` (or `{{DOMAIN}}`) with the target. It's written to run identically across all 100+ sites, so treat wording changes carefully — if you need to adjust it, adjust the template once, not per-site.

Confirmed against a live site in your DUDA account before drafting this (`eb62bd61` / Yourtown Community Church) — the tool behavior below is verified, not guessed.

---

## PROMPT (copy from here)

You are extracting everything needed to rebuild `{{SITE_NAME}}` on WordPress/Oxygen, as faithfully as possible to how it currently looks and reads. This is an **extraction task only** — you are not building anything in WordPress in this task, and you must not modify anything in DUDA. Output is one structured content package that a separate build task will consume.

### Why this has two phases, not one

DUDA's API gives you two different kinds of data, and they don't overlap the way you'd expect:

- **What the API gives you directly:** page list with SEO metadata (title, meta description, URL path), the site's global design tokens (color palette with semantic labels, heading/paragraph typography, button styles, section spacing), and business contact info (name, phones, emails, address, category, tone of voice) from the content library.
- **What the API does NOT give you:** the actual page body — no widget content, no paragraph text, no images. `get_content_library`'s `site_texts` and `site_images` fields come back empty even on a fully-built site; body content lives inside DUDA's proprietary Flex page structure, which is not exposed through any read tool available to you.

So: use the API for structure and design tokens (Phase 1), then browse the live pages yourself for the actual words and pictures (Phase 2). Skipping Phase 2 because Phase 1 "worked" will produce a manifest with a design system and no content in it.

### Phase 1 — Structured inventory (API)

Call, in order:
1. `get_site_details` — confirm the site, get `canonical_url`, `publish_status`, and `preview_site_url`.
   - If `publish_status` is `PUBLISHED`, use the live `canonical_url` for Phase 2.
   - If it's `NOT_PUBLISHED_YET` or `UNPUBLISHED`, use `preview_site_url` instead — it works unpublished and already carries its own auth token in the URL. Don't strip or modify that URL.
2. `list_pages` — every page's path, title, and SEO block. This is your page list for Phase 2 — visit every path returned here, nothing more, nothing less.
3. `get_site_theme` — the full color palette (note the semantic `label` on each color, e.g. "Accent Gold" — carry these labels forward, they'll become your Oxygen global class names) and typography per heading level, button styles, and section spacing. Record this verbatim; it's the single most useful thing the API gives you and maps almost directly onto Oxygen global colors/classes.
4. `get_content_library` — business name, description, category, tone of voice, phones, emails, physical address. This is your source of truth for contact info — more reliable than scraping it off a Contact page, since it's structured.
5. If the site has a blog (check for a blog feature/labels), `list_blog_posts` then `get_blog_post` for each — unlike regular pages, blog posts **do** return full content through the API. Don't re-scrape blog posts in the browser; pull them here.
6. If `store_status` is not `NONE`, stop and flag it — do not attempt to migrate store/product data as part of this content extraction. Note it in the manifest's `flags` array and move on; e-commerce migration is a separate, bigger task (WooCommerce mapping, not a copy-paste).
7. If `booking.status` is not `NOT_INSTALLED`, same treatment — flag it, don't attempt to extract booking data here.

### Phase 2 — Live page content & images (browser)

For every path from `list_pages`, open `{base_url}/{path}` (base_url = canonical_url or preview_site_url from step 1) and extract, in reading order top to bottom:

- Every heading and paragraph of visible text, tagged with which section it belongs to (hero, about block, staff grid, service times, etc. — use your judgment on section boundaries, but keep the order)
- Every image: full-resolution `src` URL, `alt` text if present, and what role it plays (hero background, staff headshot, logo, gallery item, icon). DUDA serves images off `irp.cdn-website.com` — grab the direct file URL, not a lazy-load placeholder.
- Any embedded video/livestream (YouTube, Vimeo, Facebook Live) — capture the embed URL, not a screenshot of it.
- Navigation: header menu items (label + target) and footer menu items, in order.
- Any form on the page: every field's label and type (text, email, dropdown, etc.) and the submit button text. Do not try to replicate DUDA's form backend — this is just so the rebuild step knows what fields to recreate in Fluent Forms.
- Any interactive widget (accordion, tabs, slider/carousel, map embed) — note the widget type and its content; the rebuild step will pick an Oxygen-side equivalent, you're just documenting what exists.

Take one full-page screenshot per page as a visual reference — this is a fallback for anything text extraction missed (layout intent, spacing choices, a background pattern), not the primary record.

### Phase 3 — Image handling

Download every image URL captured in Phase 2 and save it to this site's folder in the workspace file library — don't leave images as remote DUDA URLs in the manifest, they should be portable once DUDA access goes away. Name files predictably: `{page-slug}-{role}-{n}.{ext}` (e.g. `home-hero-1.jpg`, `about-staff-2.jpg`). Record each image's saved filename, original alt text, and pixel dimensions in the manifest.

### Phase 4 — Output

Produce one JSON file per site, saved to the workspace file library as `{{SITE_NAME}}-extraction.json`, shaped like this:

```json
{
  "source": {
    "duda_site_name": "eb62bd61",
    "duda_domain": "yourtown-community-church.multiscreensite.com",
    "extraction_date": "2026-09-10"
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
    "typography": { "h1": {"font_family": "Lora", "font_size": "56px", "..."}, "paragraph": {"..."} },
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
          "images": [{"file": "home-hero-1.jpg", "alt": "...", "role": "background"}]
        }
      ],
      "forms": [{"fields": [{"label": "Your Name", "type": "text"}], "submit_label": "Send"}],
      "embeds": [{"type": "youtube", "url": "..."}]
    }
  ],
  "blog_posts": [
    {"title": "...", "content": "...", "published_date": "..."}
  ],
  "flags": [
    "store_status: BASIC — e-commerce present, not extracted, needs separate handling",
    "booking installed — not extracted, needs separate handling"
  ]
}
```

### Phase 5 — Sanity check before moving to the next site

Before marking a site done, confirm:
- Page count in your manifest matches `list_pages`' count exactly.
- Every image referenced in a section has a corresponding downloaded file — no dangling remote URLs.
- The `flags` array captures anything you skipped (store, booking, an embed you couldn't identify, a font in `get_site_theme` that isn't a standard Google Font).

Don't proceed to rebuilding this site in WordPress as part of this task — extraction and rebuild are separate steps so a bad rebuild doesn't force redoing the extraction.

## PROMPT (copy to here)

---

## A few things worth knowing before running this across 100+ sites

- **`list_sites` is paginated** (default page size 25, max 200) — your account currently has 366 sites in it, so if you ever have Noah enumerate the whole account rather than working off a supplied list, it needs to page through with `offset`/`next_offset`, not assume one call gets everything.
- **Unpublished sites work fine for extraction** — most of what's in the account right now shows `NOT_PUBLISHED_YET`, and the `preview_site_url` handles that transparently (it carries its own signed auth token). No need to publish a site just to extract it.
- **Read-only and safe** — nothing in this prompt writes to DUDA. You can run it against all 100+ sites without any risk of touching the source sites, which means it's safe to run unattended/in bulk once you've spot-checked the first few manifests.
- **Spot-check before trusting it at scale** — run this on 2-3 sites first and actually open the resulting JSON + downloaded images before pointing it at all 100+. The theme/content-library extraction (Phase 1) is API-verified and reliable; the browser-crawl extraction (Phase 2) depends on how consistently each site's editor laid out sections, which will vary more than the API side does.
- **This feeds directly into the WP playbook you already have** — the `design_tokens` block maps onto Oxygen global colors/classes, and the per-page `sections` array is close to what `oxygen-html-to-page` wants as input. Worth writing the "rebuild" prompt as a second task that consumes this JSON directly, rather than describing it from scratch each time.
