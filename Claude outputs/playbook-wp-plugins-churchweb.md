# Playbook additions — WordPress plugin knowledge for Noah

**Scope to set in Admin → Playbooks:** `wp-sites` (same builtin slug as the existing WP-sites playbook — append these as new sections rather than a separate playbook, so Noah reads them in one pass on every WordPress task).

Each section below states what's actually true about how the plugin stores/exposes its data, then the "how to apply" rule Noah should follow. Where I'm not 100% certain of the current version's exact schema, I've flagged it — verify with the same method you already use for Oxygen/Rank Math: check `/wp-json/` for the plugin's REST namespace, do one test write, confirm from the outside before trusting the pattern.

---

## Fluent Forms / Fluent Forms Pro

Forms and entries live in **custom DB tables** (`wp_fluentform_forms`, `wp_fluentform_form_meta`, `wp_fluentform_entries`), not in `post_content` — core WP REST won't see them. Fluent Forms Pro ships its own REST namespace (`fluentform/v1`) for entries/forms when its REST API module is enabled; without Pro (or with the module off), there is no REST surface at all.

**How to apply:**
- Before attempting anything, check `/wp-json/` for a `fluentform/*` namespace. If it's missing, the REST module isn't enabled — don't guess endpoints, tell the operator.
- A form's structure is JSON (`form_fields` column). The safe way to create/duplicate a form is Fluent Forms' own **Import Form** feature (Settings → Import/Export), fed a JSON template you build once and store in the file library — not hand-assembled field JSON, which has undocumented internal shape (conditional logic, conversational-form flags, etc.) that's easy to get subtly wrong.
- Never write directly to the `wp_fluentform_*` tables via raw SQL/WP-CLI `db query` — always go through the plugin's own import/REST path so its internal caches and hooks fire.

---

## The Events Calendar

Events are a core WordPress CPT (`tribe_events`), fully REST-addressable like any post type, plus the plugin's own namespace `tribe/events/v1` for calendar-specific reads. Venue and Organizer are separate CPTs (`tribe_venue`, `tribe_organizer`) linked by ID.

Key meta on an event: `_EventStartDate`, `_EventEndDate`, `_EventAllDay`, `_EventVenueID`, `_EventOrganizerID`. Recurring events (Events Calendar Pro) use additional `_EventRecurrence` meta with its own rule format — don't hand-construct this; recurrence is one of the more fragile parts of this plugin.

**How to apply:**
- Standard `wp_mcp`/REST post-create flow works for one-off events: create as `tribe_events`, set the meta above, link venue/organizer IDs.
- For recurring services (e.g. "Sunday service, every week"), don't write `_EventRecurrence` meta directly — use the plugin's admin UI once to establish the pattern, or flag to the operator that recurrence needs manual setup rather than guessing the rule format.
- Verify a created event actually appears via `tribe/events/v1/events`, not just via `wp post list` — the CPT existing doesn't guarantee the calendar views are picking it up (cache/date-query edge cases).

---

## Max Mega Menu / Pro

This one does **not** have a REST API and its configuration is split across two places: standard WP nav menus (`nav_menu` taxonomy + `nav_menu_item` posts — fully WP-CLI addressable via `wp menu`) plus Mega-Menu-specific settings stored as an option (per-menu behavior: is-it-a-megamenu, hover/click trigger, effect) and postmeta on individual `nav_menu_item` posts (per-item settings: columns, icon, flyout width, panel content).

**How to apply:**
- Build the actual menu structure (pages, order, parent/child) with standard `wp menu` CLI commands — this part is safe and well-documented.
- Don't try to configure the "mega" visual behavior (multi-column flyouts, icons, panel widgets) blind through raw option/postmeta writes — the key names aren't part of any public API contract and can change between plugin versions. Leave that as a manual step in wp-admin, or have Ryan confirm the exact option/meta keys against the live site's DB before Noah touches them programmatically.
- Treat "menu structure" and "mega-menu styling" as two separate tasks with two different confidence levels.

---

## Slider Revolution

No REST API, no WP-CLI commands. Sliders/slides live in custom tables (`wp_revslider_sliders`, `wp_revslider_slides`) as large serialized/JSON blobs describing layers, timing, and animation — this is the least standardized data format of anything in the stack and not meant to be hand-edited or generated from scratch.

**How to apply:**
- Never attempt to construct slide JSON directly. The only reliable path is: build the slider once visually (you or Ryan) as a Slider Revolution export `.zip`, store the exported templates in the file library (one per hero-banner style you want reusable across the 10 church templates), and have Noah **import** the matching template into a new build via Slider Revolution's own import feature.
- If a task asks Noah to "create a new hero slider," the correct response is to check whether a matching exported template already exists — not to generate one.

---

## EmbedPress / EmbedPress Pro

Good news relative to the others: EmbedPress has no separate storage — it's a Gutenberg block / shortcode (`[embedpress url="..."]`) that lives in ordinary `post_content`. It composes cleanly with Noah's existing Oxygen/DiviOps content-write path; no separate API needed.

**How to apply:**
- To embed a livestream (YouTube Live, Vimeo, Facebook Live) in a template, just place the `[embedpress url="..."]` shortcode inline wherever the page content is being written — same write path as any other content block.
- Pro-only features (watch-later, popups, ad control) are configured via block/shortcode attributes, not a separate settings API — if a template needs one of those, the attribute needs to be included in the shortcode itself, not applied afterward.

---

## Rank Math SEO / Pro (addendum to existing namespace-check knowledge)

Noah already checks the `rankmath/v1` REST namespace to detect whether the plugin is active (this is how the LiteSpeed object-cache bug was diagnosed). What's not yet documented: Rank Math registers its own post-meta keys with `show_in_rest`, so per-page SEO fields are writable the same way as any other post meta:

- `rank_math_title`, `rank_math_description`, `rank_math_focus_keyword` — per-post SEO fields.
- Site-wide settings (schema defaults, sitemap toggle) live in options (`rank-math-options-general`, `rank-math-options-titles`), not per-post — don't try to set these per page.

**How to apply:**
- When a template calls for church-specific SEO (e.g. "Church" or "LocalBusiness" schema, focus keyword per page), write directly to the `rank_math_*` post-meta fields rather than going through wp-admin.
- After writing, verify by reading the meta back (not just a 200 on the write) — confirm the value round-trips before considering the SEO step done.

---

## Meta Box AIO — placeholder, fill in once field groups exist

Not enough is defined yet to write real guidance here. Meta Box typically exposes custom fields either as standard postmeta (simple fields, usually REST-visible if "show in REST" is set per field) or as a serialized group (repeater/group fields, not natively REST-visible without extra config). Once you define the actual field groups you want across the 10 templates (staff bios, sermon series, service times, etc.), this section should be filled in with the exact meta keys and whether each is REST-exposed — that's a five-minute check against `/wp-json/wp/v2/pages/<id>` once the fields exist, not something to guess ahead of time.

---

### General rule for all of the above

If a plugin has no REST namespace and no WP-CLI commands, the safe default is: don't have Noah reverse-engineer its internal storage format. Either (a) it's core-WP-shaped enough that `wp post`/`wp menu`/postmeta tools already cover it, or (b) it needs a pre-built export/template that gets imported rather than generated. Only Slider Revolution and Max Mega Menu's visual config fall into the second bucket among this list.
