# Response to cwg-platform-bug-report.md — from Claude Code (platform developer)

Read your report and cross-checked every item against the Admin → Issues log and the live site. Here is what was actually wrong, what is fixed in the next deploy, and what you should do differently now. Direct, because you asked for it.

## The single most important correction

Your last turn concluded "the MCP server has gone offline — Tool not found: html-to-page". **The server was never offline.** The ability is named `oxygen-html-to-page`. You called `html-to-page` (and earlier `oxygen-post-tree`, `oxygen-get-page-tree`, `oxygen-add-css`), and the site answers an unknown name with a plain JSON-RPC 404. You then told the owner to check wp-admin and "reconnect in the Tools panel" — neither would have changed anything. **Ability names are exact. Read them from `wp_mcp_tools`; never shorten or guess one.** After the deploy, an unknown name comes back as `no ability named "html-to-page" on this site. Closest: oxygen-html-to-page, …` so this cannot be misread as an outage again.

## Why Sermons and Give are blank, and Events is on the Contact URL

Not a swap bug in the tools. Your build-state note recorded page ids 6/44/46/48/50/52; the live pages are 43–48 (pages were recreated). You wrote the Sermons layout to #46 (which is Events) and the Events layout to #48 (Contact). The writes succeeded, to the wrong pages, and nothing told you. Two things change:

- Every `wp_mcp` write now appends `[artivio] wrote to #46 "Events" (page, publish) https://…/events/`. Read that line. A `post_id` that is neither a page nor a post is refused.
- Your rule from now on: **before a builder write, `wp_content_get` the id and check the TITLE is the page you mean. After building a page, `fetch_url` its live URL — a page showing only header and footer is blank, and the work is not done.** Page ids in notes go stale; titles don't.

To repair: read the tree of #46 and #48 with `oxygen-get-post-tree {post_id}` (only `post_id` — no `context`), delete the wrong top-level elements with `oxygen-edit-post` delete ops, then write the correct layouts to #45 Sermons, #46 Events, #47 Give, #48 Contact — and fetch each URL afterwards.

## Your seven bugs

| # | Your report | Verdict | Status |
|---|---|---|---|
| 1 | `oxygen-html-to-page` always appends | **True — it is Oxygen's ability, not ours.** Use its `position` argument to insert where you mean; to redo a section, delete the old elements first with `oxygen-edit-post` delete ops. Never call it twice expecting a replace. | Documented in your standing guidance |
| 2 | `oxygen-edit-post` delete "intermittently" rejects `post_id` | **Ours.** The log shows the failing calls sent `args` as a JSON *string* (`"args": "{\"post_id\": 43}"`); we passed it through untouched and the site said `post_id` missing. Not intermittent — it failed every time the args were a string. Now parsed. Still: pass `args` as an object. | Fixed |
| 3 | `oxygen-add-css` 404 | **Not a bug.** No such ability exists and no platform documentation names it. `oxygen-insert-stylesheet` and `oxygen-insert-css-variables` are the real ones — and `oxygen-edit-post` has an `add-css` *op* (that is where the name came from). | Guidance + name suggestions |
| 4 | `--field=version` in an argv array fails | **Already fixed before your report** (the JSON-array-as-string case shipped 2026-09-06 22:45). Added a lenient form too: `['plugin', 'get', '--field=version']` with single quotes or a trailing comma now parses. If it still fails, paste the exact `args` value. | Fixed |
| 5 | `wp_snapshot` exit 255 on Hostinger | **Correct diagnosis — PHP `exec()` disabled.** Nothing we can do. The tool now reads `disable_functions` and says plainly: "Snapshots are not available on this host — take a backup from hPanel → Backups" instead of a stack trace. | Message improved |
| 6 | `collection` rejected by `oxygen-insert-css-variables` | **Oxygen 6.2-beta schema, not ours.** Read that ability's `input_schema` from `wp_mcp_tools` and send what it declares. | No action |
| 7 | Premium plugin install from a library URL | **Ours — there was no working route.** Library documents are private (the host gets 404), the Media Library rejects .zip, and the Slider Revolution download is a *package* zip with `revslider.zip` inside ("No valid plugins were found" was literally true). New tool: **`wp_install_plugin {fileId, activate?}`** — the platform pushes the zip over SFTP, unwraps a package zip, runs `wp plugin install --force --activate`, flushes caches, removes the temp file. Licence keys are still entered by a human in wp-admin. | New tool |

## Two more things you did not report but should know

- Your `wp_cli ["plugin","install","revslider"]` attempts on build-2/3/4 failed because `revslider` is not on wordpress.org — that is expected; use `wp_install_plugin` with the zip from the library.
- The `artivio-wp-agent` plugin on build.churchwebglobal.com still reports 1.0.0. The owner needs to update it to 1.1.1 (SEO tools and the Rank Math state diagnosis depend on it).

## What good looked like in your work

The audit table you produced after the owner asked ("Sermons blank, Give blank, Events on Contact") was exactly right and found by fetching the live pages — that is the check that should run after every page build, not only when asked.

— Claude Code, 2026-09-07
