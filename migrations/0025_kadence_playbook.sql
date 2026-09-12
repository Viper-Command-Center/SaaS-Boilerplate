-- Phase 44 — seed a "wp-sites" scoped operator playbook teaching Kadence
-- conventions. Noah reported not being familiar with Kadence; three
-- successive rebuild attempts on Erindale United Church all reproduced the
-- same visual defects because they were global Customizer settings
-- (Global Palette slot value, boxed layout + dark site background, an
-- asymmetric Row Layout gutter margin), not markup problems — confirmed
-- live via computed-style inspection against build1/build3.churchwebglobal.com
-- on 2026-09-12. This playbook reaches every workspace with WordPress Sites
-- enabled (scope 'wp-sites'), live on the agent's next turn, no deploy
-- needed for future edits — see src/libs/agent/playbooks.ts.
--
-- Idempotent (no unique constraint on scope+title to hang ON CONFLICT off
-- of, so guard with NOT EXISTS instead — same intent as 0020/0021/0022/0024).
INSERT INTO "playbooks" ("scope", "title", "body")
SELECT
	'wp-sites',
	'Kadence page-builder conventions',
	$BODY$Kadence (theme + Kadence Blocks) — read this before touching layout on any site whose site_check/wp_sites report shows Kadence. Written after three failed rebuild attempts on Erindale United Church all reproduced the same defects because they were diagnosed as markup bugs when they were global settings bugs.

WHERE THE CONTENT LIVES — good news vs Elementor/Oxygen
Kadence Blocks are native Gutenberg blocks stored in post_content as ordinary block comments (`<!-- wp:kadence/rowlayout {...json...} -->`), the same place core WP stores everything. wp_content_get / wp_content_update show the REAL layout — unlike Elementor, there is no protected postmeta hiding the truth. Use wp_content_get before editing a page, exactly like any other WP page, then wp_content_update to write it back. Kadence block class names you will see: `wp-block-kadence-rowlayout` / `kb-row-layout-wrap` (a Row), `wp-block-kadence-column` / `kt-row-column-wrap` (a Column inside a Row), `wp-block-kadence-advancedheading`, `wp-block-kadence-listitem` / `kt-svg-icon-list` (Icon List), `wp-block-kadence-singlebtn` (button).

THE #1 TRAP — Global Palette is a PER-SITE VALUE, not part of the markup
Kadence blocks style text/backgrounds with `color: var(--global-palette2, #fallback)` — the block only carries a fallback; the REAL rendered color is whatever this site's palette slot 2 currently holds, set once per site in Customize → Colors (stored in the theme_mods_kadence option, classic array of hex values, index 0 = palette1). Two sites can share byte-identical block markup and render completely differently if their palette arrays differ. CONFIRMED LIVE on Erindale: the Icon List block correctly does `color:var(--global-palette2,...)` — identical to a known-good reference site — but Erindale's own palette slot 2 was set to #EFED99 (pale yellow) while the reference site's was #2B6CB0 (blue). Pale-yellow-text-on-white was not a markup bug and no amount of "copy the verified markup" fixes it.
RULE: before styling or debugging anything that uses a palette color, read the site's actual palette first — `wp_cli` `option get theme_mods_kadence --format=json` and look at the array under the `global_palette` (or `kadence_global_palette`, key name has moved across Kadence versions — read the option once and use whatever key is actually there) — never assume palette-N means a particular color just because it did on another site.
CONVENTION when you set up a NEW site's palette: slots 1–3 are the ones almost every default block style reaches for, so keep 1 = primary/dark, 2 = a real accent color with contrast against BOTH white and palette1 (never a pastel near-white), 3 = white/near-white. Slots 4–9 are extended shades — safe to be more adventurous there.
TO CHANGE ONE SLOT WITHOUT CLOBBERING THE REST: theme_mods_kadence is one serialized option holding many unrelated settings. Read it first (`option get theme_mods_kadence --format=json`) to see the exact current shape, then write back the WHOLE option with just that one array entry changed (`option update theme_mods_kadence '<json>' --format=json`), or use `option patch` if the nesting is shallow enough for a dotted path — verify the path against what you just read rather than guessing one. Never hand-guess a key name with confidence; a wrong key silently creates a new unused option and changes nothing.

THE #2 TRAP — boxed layout + dark site background = vertical bars down both edges
Kadence's Customizer has a site-wide Layout setting (General → Site Layout, or the block-theme equivalent) that puts `content-style-boxed` (vs `content-style-unboxed`) and `content-width-normal|wide|fullwidth` classes on `<body>`. "Boxed" insets the actual content into a centered column narrower than the viewport; whatever color `<body>` itself is painted becomes visible in the gutters on both sides. CONFIRMED LIVE: Erindale is `content-style-boxed` with a dark navy body background (`#0d1a2e`, matches global-palette8) — result: two solid navy vertical bars flanking every page, mistaken for a page-content defect. The known-good reference site is `content-style-unboxed` (fullwidth) with a near-white body background, so the same setting, if it existed there, would be invisible.
RULE: boxed layout only looks intentional when the body background is light/neutral or matches the content background. A dark or saturated body background needs unboxed/fullwidth layout, or the body background changed to match. This is a Customizer setting, not a block — no markup fix touches it. Check `document.body`'s class list and background before ever touching a Row's own background.

THE #3 TRAP — Row Layout column-gutter negative margins must be symmetric
A Kadence Row's multi-column wrapper (`kt-row-column-wrap`) implements the gap between columns with a negative margin on the wrapper cancelled by matching padding on each column. A CORRECT one has margin-left and margin-right equal and both negative (e.g. -20px / -20px, compensating 20px of column padding on each side). If you ever see only one side negative (e.g. `margin-right: -40px` with `margin-left: 0`), that Row's layout is broken/hand-edited state, not a valid pattern — it shears the whole row visibly off-center and must never be copied into a "reference" pattern library as-is. This exact asymmetry was found live in Erindale's Upcoming Services row.

MANDATORY VERIFICATION STEP — do this before ever reporting a build/fix as done
A successful wp_content_update or a page that "looks right in the outline" is not evidence of anything visual. Kadence's real failure modes here are invisible in markup: a palette slot, a boxed/background pairing, an asymmetric margin. If a cloud-browser/preview connection is available, load the live page and pull real computed styles — text `color` vs. its background's `background-color` (contrast), and `document.body`'s background at the far left/right edges of the viewport vs the content container's background. Report exact hex/rgb values found, not "it looks fine now." This is literally how every defect above was caught and none of them would show up from reading block JSON alone.

DO NOT treat another site's markup as "verified" for anything but STRUCTURE
Extracting a working page's block tree as a pattern library is fine for structure (which block types, what nesting, what attributes exist) but says nothing about how it will render on a different site, because palette values, layout/boxed setting, and typography scale are ALL per-site Customizer state, invisible in the block JSON. Before reusing a "verified" pattern on a new site, diff the two sites' theme_mods_kadence (palette array, content_style/content_width keys) — matching structure with mismatched site-level settings reproduces the exact same visual bug on the new site, faithfully, every time.$BODY$
WHERE NOT EXISTS (
	SELECT 1 FROM "playbooks" WHERE "scope" = 'wp-sites' AND "title" = 'Kadence page-builder conventions'
);
