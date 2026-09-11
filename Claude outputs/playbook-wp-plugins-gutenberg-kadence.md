# WordPress Plugin & Builder Playbook — Gutenberg + Kadence Stack

**Scope to set in Admin → Playbooks:** `wp-sites` (replaces the earlier Oxygen-era playbook — that stack is retired). Reflects the confirmed plugin list on build6.

Each entry: what's actually true about the plugin's storage/API, then the rule to follow. Where unverified against a live install, flagged as such — confirm with a test write before trusting.

---

## Builder — Gutenberg + Kadence Blocks (+ PRO Extension) + Kadence Theme (+ Theme Kit Pro)

- Content lives as block-comment HTML directly in `post_content`. Read/write via `content.raw` (source, needs `edit_posts` auth) — never `content.rendered` (computed output only).
- Every Kadence block requires a unique `uniqueID` attribute (e.g. `"uniqueID":"_abc123"`). Duplicate IDs across blocks collide in the compiled CSS — generate a fresh random string per block, always.
- After writing/updating raw content, trigger a cache/recompile so Kadence regenerates its block CSS. Same bug class as the LiteSpeed stale-cache issue already seen on this stack — don't trust a 200 response alone, verify the page renders correctly after any bulk write.
- Dynamic Content tags (binding a block to a custom field) live as attribute JSON on the block itself: `"dynamicAttributes":{"content":{"source":"post:custom","sourceId":"<meta_key>"}}`. If the target meta key doesn't exist on that post, Kadence silently falls back to the block's static text — no error. **ACF isn't installed on this stack yet** — don't write `dynamicAttributes` pointing at ACF-shaped fields until it's added.
- Global colors/typography resolve through `var(--global-palette1)` etc., defined once site-wide (Appearance → Customize) and stored in `wp_options`. Reference the global token, don't hardcode hex/px per block.
- Theme Kit Pro's "Hooked Elements" (sitewide header/footer/banner injections) register as their own CPT `kadence_element`; placement/visibility rules live in postmeta (`_kadence_element_placement`, `_kadence_element_visible`) — **unverified against a live install**, confirm exact keys before writing to them programmatically.

## Starter Templates by Kadence WP

Pre-built page/site layouts pulled from Kadence's cloud library via the plugin's own import. Same rule as the old Slider Revolution guidance: if a task needs a layout, check whether a matching starter template already exists before generating one from scratch.

## SEOPress / SEOPress PRO — replaces Rank Math

- ⚠️ **Artivio WP Agent's built-in SEO read/write only recognizes Rank Math or Yoast — it does not know SEOPress.** Don't route SEO tasks through it on this stack.
- Use SEOPress's own REST routes directly: `GET /wp-json/seopress/v1/posts/{id}` to read, `PUT /wp-json/seopress/v1/posts/{id}/title-description-metas` with JSON body `{"title":"...","description":"..."}` to write. Requires `edit_post` capability.
- Underlying meta keys (`_seopress_titles_title`, `_seopress_titles_desc`, `_seopress_analysis_target_kw`) are protected/underscore-prefixed and not REST-visible on their own — go through the REST routes above, not raw postmeta.

## Artivio WP Agent (base)

Per its own description: repairs Application Passwords on CGI/FastCGI hosts, exposes a self-diagnosing auth check, reports what a site runs, reads/writes SEO for Rank Math/Yoast only (see SEOPress note above). Treat anything outside that list as not covered — don't assume broader capability.

## Contact Form 7 — replaces Fluent Forms

No REST API, no submission storage by default. A form is a `wpcf7_contact_form` CPT with its field markup in postmeta; submissions go out by email only — there's nothing to query afterward unless a DB-logging add-on is added. Build/duplicate a form via standard `wp post`/postmeta tools, or build one visually once and clone it.

## The Events Calendar — unchanged

CPT `tribe_events`, REST-addressable (`tribe/events/v1`). Key meta: `_EventStartDate`, `_EventEndDate`, `_EventAllDay`, `_EventVenueID`, `_EventOrganizerID`. Recurring events (Pro) use `_EventRecurrence` — don't hand-construct the rule, set the pattern up once via the UI. Verify a created event through `tribe/events/v1/events`, not just `wp post list`.

## AIOS (All-In-One Security)

Hands-off for Noah — admin-UI config, no REST surface expected. One hard rule: **never change the DB table-prefix setting programmatically** — this already caused a full wp-admin lockout once on this stack. Prefix changes are human-only.

## LiteSpeed Cache

Flush after any plugin/theme/core/option/rewrite change or bulk content write — unchanged from prior guidance, applies the same way under the new builder.

## Kadence CAPTCHA, Kadence Child Theme Builder, UpdraftPlus, WordPress Importer, WP Mail SMTP Pro

Admin-configured, one-time or occasional setup — no ongoing agent interaction expected. Kadence Child Theme Builder is the mechanism for producing the 10 church template variants from one parent build: a one-time step per template, not a per-task action.

## General rule

No REST namespace and no WP-CLI support → don't reverse-engineer the storage format. Either core WP tooling already covers it (postmeta, CPTs, nav menus), or it needs a pre-built export/template imported rather than generated blind.
