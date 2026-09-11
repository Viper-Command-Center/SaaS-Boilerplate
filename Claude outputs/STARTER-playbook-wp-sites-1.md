# WordPress Sites playbook — scope: WordPress Sites (wp-sites)

Paste into Admin → Playbooks (Applies to: WordPress Sites) to replace what's there now. Trim anything you disagree with; it is yours now.

**Updated 2026-09-11 — Oxygen retired.** Every WordPress build is now Gutenberg + Kadence Blocks. The old Oxygen section is gone; the two Artivio plugins (`artivio-wp-agent`, `artivio-abilities-bridge`) are the standard companion install on every site, and there's no builder branch to reason about anymore.

---

**Before you touch a page**
- Page ids in notes go stale. Confirm the id's TITLE with `wp_content_get` before any write. Every `wp_mcp` write reports `[artivio] wrote to #id "Title"` — read it.
- Take `wp_snapshot` before bulk or destructive changes. If the host cannot snapshot (Hostinger: PHP exec() disabled), tell the owner to back up from hPanel → Backups and ask before proceeding.

**Content — Gutenberg + Kadence Blocks**
- Kadence Blocks ARE Gutenberg blocks — content lives in ordinary `post_content` block markup, not a separate layout store the way Oxygen/Elementor/Divi/Bricks worked. Standard content writes to `post_content` work directly; there is no element-tree ability to call instead.
- Don't hand-write Kadence's block markup from scratch. Read the existing page's `post_content` first (`wp_content_get`) and edit or extend the block comments/attributes you find there, rather than guessing Kadence's block schema from memory.
- ACF PRO fields (where a template uses them) are exposed through core REST — read/write them as the post's `meta`/ACF REST fields, not through a bespoke ability.

**SEO — Slim SEO**
- Every site now runs Slim SEO (Pro tier). It stores all fields as ONE JSON object under a single `slim_seo` postmeta key (`title`, `description`, `facebook_image`, `twitter_image`, `canonical`, `noindex`) — not one meta key per field like Rank Math/Yoast/SEOPress did.
- Preferred path: `GET`/`PATCH /artivio/v1/documents/{id}/seo` (artivio-wp-agent ≥ 1.3.0) — it detects Slim SEO and reads/writes that JSON object for you. The response's `seoPlugin` field should read `"slimseo"`.
- Fallback if that route ever misbehaves: read/write directly via `GET`/`PATCH /wp/v2/pages/{id}` with `_fields=meta` / `{"meta":{"slim_seo":{...}}}` — Slim SEO exposes that meta key through core REST natively, no custom namespace needed.
- `artivio/seo-get`/`artivio/seo-set` (the MCP abilities) are confirmed working as of artivio-wp-agent v1.3.0 being live — use whichever path is convenient. If either one errors, it's worth doubling back to the REST path above before assuming something is broken.

**Ability names**
- MCP ability names are exact and come from `wp_mcp_tools`. Never guess or shorten one. "Tool not found" means the name is wrong, not that the site is down.
- Pass `wp_mcp` args as a JSON object, never a string.
- The Artivio-specific abilities on this stack: `artivio/cf7-create-form` (Contact Form 7 — returns a shortcode, paste it into a Kadence block), `artivio/event-create` (The Events Calendar — send `startDateTime`/`endDateTime` as `"Y-m-d H:i:s"`; the plugin handles the site's configured date format and all-day/time-of-day internally as of v1.3.0), `artivio/cache-purge` (LiteSpeed). `artivio/seo-get`/`seo-set` also exist but see the SEO section above before using them.

**After you build**
- `fetch_url` the live page. Header + footer only = blank = not done. Do this for every page you built, not only when asked.
- Flush caches (`wp_cache_flush`) after plugin/theme/layout changes.

**Plugins**
- Premium plugin zips: `wp_install_plugin` with the library file id. Never `wp plugin install <library URL>` (private) and never via the Media Library (.zip is rejected). Licence keys are entered by a human in wp-admin.
- Nothing on wordpress.org? Ask the owner for the zip; do not try the slug on three sites.
- Install BOTH `artivio-wp-agent` and `artivio-abilities-bridge` on every site — the base plugin alone doesn't expose events/forms/cache-purge abilities, and the abilities bridge alone has no SEO route or auth-repair diagnostics.
- After "installing an update," a zip sitting on the developer's side or even in this workspace's file library is NOT the same claim as "it's live on this site" — a fix can be written and delivered and still never actually get uploaded and installed. Before trusting or scoring a re-test of a fix, check the plugin's OWN reported version (`artivio-abilities-bridge`: `GET /wp-json/artivio-abilities/v1/status` → `pluginVersion`; `artivio-wp-agent`: `GET /artivio/v1/site` → `pluginVersion`) rather than assuming. The two plugins can be at different real versions on the same site at the same time — check each one separately.

**Reporting**
- When something fails, relay the exact error. Do not invent troubleshooting steps ("reconnect in the Tools panel") that the error did not state.
- If an error says a tool's "credential was rejected," treat that with suspicion before believing it — Artivio's own generic error classifier is known to misreport a plain WordPress permission decision as a bad API key (open issue, 2026-09-11). Ask for the raw error rather than assuming the credential is actually wrong.
- Write a build-state note to the library as you go, and re-read it — with the page ids re-checked — at the start of the next session.
