-- Phase 45 — seed a "wp-sites" scoped operator playbook teaching Divi 5
-- conventions, after Ryan decided to retire Kadence/Gutenberg entirely in
-- favor of Divi (unlimited license) for DUDA migrations. Verified live
-- against build9.churchwebglobal.com on 2026-09-12 by pulling a real page's
-- raw content over the authenticated REST API (context=edit): Divi 5 stores
-- layout as native Gutenberg blocks (`wp:divi/section`, `wp:divi/row`, …) in
-- post_content, NOT classic `[et_pb_section]` shortcodes — most "Divi
-- documentation" describes Divi 4 and is wrong for this site. The same page
-- carried blocks stamped both `5.0.0-public-alpha.23` and
-- `5.0.0-public-beta.1`, confirming Divi 5 is still pre-1.0 and its exact
-- attribute schema is a moving target — the playbook teaches the JSON
-- grammar and a mandatory "read a real instance first" discipline rather
-- than a static per-module parameter reference that would go stale on the
-- next alpha/beta release.
--
-- Idempotent (no unique constraint on scope+title to hang ON CONFLICT off
-- of, so guard with NOT EXISTS instead — same pattern as 0020/0021/0022/
-- 0024/0025).
--
-- Extended before first deploy per Ryan's explicit direction: prior
-- Kadence-era builds (and pre-playbook Divi attempts) fell back to raw
-- HTML/Code-module content whenever the agent did not know the native
-- module for a section — this adds a HARD RULE section forbidding that
-- fallback except for narrow, justified cases (see "THE FAILURE MODE
-- THIS PLAYBOOK MUST PREVENT" below).
INSERT INTO "playbooks" ("scope", "title", "body")
SELECT
	'wp-sites',
	'Divi 5 conventions',
	$BODY$Divi 5 — read this before touching any Divi site (theme is "Divi", not the classic Divi Builder plugin on a foreign theme). Verified live against build9.churchwebglobal.com on 2026-09-12 by pulling a real page's raw content over the authenticated REST API — do not trust older Divi training knowledge or generic "Divi shortcode" tutorials against a D5 site; they describe Divi 4.

IF THIS SITE HAS A DiviOps CONNECTION (stdio:diviops), PREFER IT
DiviOps exposes specialized section/module tools (diviops_section_replace, diviops_module_update, diviops_validate_blocks, etc.) that enforce Divi 5's block format automatically and ship vendor-verified starter templates (diviops_template_list) — check those before building anything by hand. Use this playbook's generic wp_content_get / wp_content_update path for sites with NO DiviOps connection, or as a read-only way to verify what DiviOps wrote.

CRITICAL CONTEXT — Divi 5 is pre-1.0 and its schema moves
The homepage pulled from build9 had blocks stamped `"builderVersion":"5.0.0-public-alpha.23"` AND `"5.0.0-public-beta.1"` on the SAME page — two different pre-release builds edited the same content. Divi 5 has not reached a stable 1.0 release. Its attribute JSON shape has already changed between alpha/beta point releases and will keep changing. CONSEQUENCE: never hand-write a module's JSON from memory, from this playbook, or from ANY static documentation (including Elegant Themes' own docs, which lag the alpha/beta releases). The one rule that stays true across every build: READ A REAL EXISTING INSTANCE OF THAT MODULE TYPE ON THIS SITE FIRST, then edit a copy of exactly what you read. A freshly-authored block from the site's own current Divi version is the only source of truth that cannot be stale.

STORAGE FORMAT — good news, same channel as Kadence
Divi 5 does NOT use classic `[et_pb_section]` shortcodes. It stores native Gutenberg blocks in post_content: `<!-- wp:divi/section {json} -->`, `wp:divi/row`, `wp:divi/column`, `wp:divi/heading`, `wp:divi/text`, `wp:divi/image`, etc., nested exactly like any other Gutenberg block tree. This means the EXISTING wp_content_get / wp_content_update tools (same ones used on every plain WordPress and Kadence site) already read and write Divi 5 layouts correctly — confirmed live via `context=edit` REST. No companion plugin, no new connector — unlike Elementor, Divi 5's layout is never hidden behind protected postmeta.
Relevant postmeta: `_et_pb_use_builder` = "on" enables the Divi Builder for that post (check/set this if a page you create doesn't render as a Divi page); `_et_pb_old_content` is a legacy-compat fallback (usually empty on a D5-native page); `_et_gb_content_width`.

THE JSON GRAMMAR — learn the pattern, not each module by rote
Nearly every module's styling attributes follow one shape:
`module.decoration.<category>.<breakpoint>.value.<property>`
categories seen live: background, spacing (padding/margin), border, layout, boxShadow, font. Breakpoints are `desktop` / `tablet` / `phone`, each independently overridable — set only the breakpoint you mean to change, the others inherit from desktop if absent.
Module-specific content sits in its OWN top-level key alongside `module` — e.g. Heading carries `title.decoration.font...` for typography and the actual text at `innerContent.desktop.value`; Text carries `content.decoration.headingFont.<h1..h6>...` for the rich-text font ladder. Read one real Heading and one real Text block on the target site before writing either, to confirm the current field names — this detail is exactly the kind that shifts between alpha builds.
Every block also carries `modulePreset`: an array with either `["default"]` or a Design-System preset UUID. A module using a preset UUID inherits every style field it does NOT explicitly set from that shared preset — the explicit fields in the block are the only true per-instance overrides.
RULE: before restyling a module, check whether it references a shared preset (a UUID, not "default"). Editing the PRESET (Divi's Design System / Preset Manager) changes every module using it, site-wide — the correct move for "make all cards match." Editing one module's own explicit fields is a one-off override — the correct move for "just this one card." Confusing the two either fails to propagate a brand-wide change or unintentionally breaks consistency across a page.

SIZE — pages are big, edit surgically
One real homepage's raw content was 105,635 characters. A full read-modify-write PATCH of `content` for a small text change is expensive and risks corrupting distant JSON you didn't mean to touch. For a small, well-isolated change (one heading's text, one color value), prefer `wp_search_replace` against the exact, unique JSON fragment (dry_run first, always) over resending the whole content blob. For structural changes (new section, new module), read the surrounding block once, build the new block(s) in the same shape, and insert via a scoped content update. Always `wp_snapshot` before a bulk or destructive change — Divi 5 has no undo through this API.

ANIMATION / SCROLL EFFECTS — use them, this is the actual reason to be on Divi
Every Divi 5 module has first-class Option Groups for `Animation`, `Transitions`, `Scroll Effects` and `Position` (parallax-style pinning/offsets tied to scroll). These are native, not a paid add-on. When building a hero, a section transition, or a card-grid reveal, default to setting an entrance Animation or Scroll Effect on the module rather than shipping it static — a static Divi 5 build looks exactly like an old Divi 4 or Kadence build and wastes the reason this platform moved to Divi 5. Read a real module using one of these before writing your own (same "read first" rule as everywhere else) — the field names live under `module.decoration.animation` / `.transition` / `.scrollEffects` per the shared grammar above.

MODULE CATALOG — durable (names change far less than parameters); verify a name against the live site or the docs below before using a module you don't see in an existing page
Content: Accordion, Audio, Bar Counter, Before After Image, Blog, Breadcrumbs, Blurb, Button, Call to Action, Circle Counter, Code, Countdown Timer, Divider, Dropdown, Filterable Portfolio, Gallery, Group, Group Carousel, Heading, Hero, Icon, Icon List, Image, Instagram Feed, Link, Lottie, Map, Menu, Number Counter, Pagination, Person, Portfolio, Post Carousel, Post Content, Post Filter, Post Filter Items, Post Navigation, Post Slider, Post Title, Pricing Table, Sidebar, Slider, Social Media Follow, SVG, Table of Contents, Tabs, Testimonial, Text, Timeline, Toggle, Video, Video Slider.
Interactive: Comments, Contact Form, Contact Form 7, Contact Form 7 Styler, Canvas Portal, Email Optin, Login, Search.
Fullwidth: Fullwidth Header, Fullwidth Map, Fullwidth Menu, Fullwidth Portfolio, Fullwidth Slider.
WooCommerce: Shop, Woo Add to Cart, Woo Breadcrumbs, Woo Cart Products/Totals, Woo Checkout Billing/Details/Information/Payment/Shipping, Woo Cross Sells, Woo Notice, Woo Product Description/Gallery/Images/Information/Meta/Price/Rating/Reviews/Stock/Tabs/Title/Upsell, Woo Products, Woo Related Products.
Site-level building blocks worth knowing exist even though they're not page modules: Theme Builder (global header/footer/templates applied by rule across the site — build the header ONCE here, not per page), Divi Library (saved reusable sections/rows/modules — check here before rebuilding a pattern from scratch), Global Elements, Loop Builder (dynamic/repeated content from a query), Dynamic Content (pull a field instead of hardcoding text).

THE FAILURE MODE THIS PLAYBOOK MUST PREVENT — do not fall back to the Code/HTML module
This is exactly why this playbook exists: prior agent-built pages (on Kadence, and on Divi before this playbook was written) turned into walls of raw HTML — Divi 5's Code module, or a Text module's content pasted in as hand-written markup — every time the agent did not know which native module covered the section it was trying to build (a hero, a card grid, a pricing table, an icon list). That is a knowledge gap, not a builder limitation: Divi 5 ships a native module for nearly every ordinary content shape (see the MODULE CATALOG above). HARD RULE: before inserting a wp:divi/code block, or switching any module into a raw-HTML/custom-code content mode, check the catalog above for a matching native module first, and if still unsure, read a real page elsewhere on the site (or check the Divi Library for a saved pattern) for how the same shape was solved there. Legitimate Code-module use is narrow — a genuine third-party embed script, or a snippet a human supplied verbatim — never a stand-in for headings, text, buttons, images, icon lists, pricing tables, testimonials, or forms, all of which already have a dedicated module. Before reporting a page as done, re-read its content and flag (never silently ship) any wp:divi/code block that is not one of those narrow, justified cases. A page built from correctly nested native modules beats one giant HTML block that merely looks right, because the former stays editable in Divi's visual builder afterward — the latter defeats the entire reason to be on Divi instead of hand-coded HTML.

ON-DEMAND DEEP DIVE — when you need a module with no live example anywhere on the site
Fetch that module's page from the Divi 5 technical docs (https://16wells.github.io — community-maintained, comprehensive per-module and per-option-group reference) or Elegant Themes' own developer docs for its currently-documented options, but treat that as a STARTING hypothesis, not ground truth — Divi 5 is pre-release and docs lag releases. Create one real instance on a draft/test page, read it back via wp_content_get, and confirm the actual field names before building more of them. This is slower than trusting a doc outright but is the only approach that survives the next alpha release.

DUDA MIGRATION WORKFLOW
Map DUDA's section/widget structure onto Divi's Section → Row → Column → Module hierarchy conceptually (a DUDA "section" is usually a Divi Section+Row; a DUDA widget is usually one Divi module) — do not try to preserve DUDA's own markup or class names, they mean nothing in WordPress. Build the header/footer ONCE in Theme Builder rather than per page. MANDATORY VERIFICATION, same discipline as every other builder on this platform: a successful wp_content_update is not evidence of anything visual. Load the live page and check real computed styles — text-vs-background contrast, whether an entrance animation/scroll effect is actually attached to the elements meant to move, and that responsive (tablet/phone) breakpoint values were actually set and not just inherited unintentionally from desktop. Report exact values found, not "looks good."$BODY$
WHERE NOT EXISTS (
	SELECT 1 FROM "playbooks" WHERE "scope" = 'wp-sites' AND "title" = 'Divi 5 conventions'
);
