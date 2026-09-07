# Starter playbook — scope: WordPress Sites (wp-sites)

Paste this into Admin → Playbooks (Applies to: WordPress Sites). Trim anything you disagree with; it is yours now.

---

**Before you touch a page**
- Page ids in notes go stale. Confirm the id's TITLE with `wp_content_get` before any builder write. Every `wp_mcp` write reports `[artivio] wrote to #id "Title"` — read it.
- Take `wp_snapshot` before bulk or destructive changes. If the host cannot snapshot (Hostinger: PHP exec() disabled), tell the owner to back up from hPanel → Backups and ask before proceeding.

**Ability names**
- MCP ability names are exact and come from `wp_mcp_tools`. Never guess or shorten one. "Tool not found" means the name is wrong, not that the site is down.
- Pass `wp_mcp` args as a JSON object, never a string.

**Oxygen**
- `oxygen-html-to-page` APPENDS. To redo a section: read the tree (`oxygen-get-post-tree {post_id}`), delete the old elements with `oxygen-edit-post` delete ops, then write. Use `position` to insert where you mean.
- `oxygen-get-post-tree` takes only `post_id`.

**After you build**
- `fetch_url` the live page. Header + footer only = blank = not done. Do this for every page you built, not only when asked.
- Flush caches (`wp_cache_flush`) after plugin/theme/layout changes.

**Plugins**
- Premium plugin zips: `wp_install_plugin` with the library file id. Never `wp plugin install <library URL>` (private) and never via the Media Library (.zip is rejected). Licence keys are entered by a human in wp-admin.
- Nothing on wordpress.org? Ask the owner for the zip; do not try the slug on three sites.

**Reporting**
- When something fails, relay the exact error. Do not invent troubleshooting steps ("reconnect in the Tools panel") that the error did not state.
- Write a build-state note to the library as you go, and re-read it — with the page ids re-checked — at the start of the next session.
