# Noah — WordPress Capability Test Plan

**Site:** `build-churchwebglobal-com` (https://build.churchwebglobal.com — staging, Oxygen 6.2, WordPress MCP Adapter, LiteSpeed Cache, WP-CLI over SSH)
**Purpose:** prove Noah can do everything a church website needs through Artivio alone — read, write, design in Oxygen, media, SEO, maintenance — without anyone opening WP Admin.
**How to run:** paste the "Instructions for Noah" block into Noah's chat in the ChurchWeb workspace. All three channels stay on **Ask first**; Ryan approves each write in the Approvals inbox. Run phases in order; each phase has a pass condition. Noah writes results into one note as he goes.

---

## Instructions for Noah (paste this)

> Run the WordPress capability test plan against the site labelled `build-churchwebglobal-com` only. Rules:
> 1. Work phase by phase, in order. Do not skip ahead if a phase fails — report the failure with the exact tool call and error, then stop and wait for me.
> 2. Before the first write of each phase that changes content or the database, call `wp_snapshot` with a note naming the phase.
> 3. Everything you create must carry the prefix **`[ARTIVIO-TEST]`** in its title so we can find and remove it. Create as DRAFT unless a step says publish.
> 4. Never permanently delete anything; use trash. Never run search-replace with `dry_run:false`.
> 5. After every step, verify from the outside: fetch the live URL with `fetch_url` (or `wp_rest` GET) and confirm the change is actually there — a tool saying "ok" is not proof.
> 6. Keep a running note called `WordPress capability test — <today's date>` with `save_note`: one line per step, `PASS` / `FAIL` / `SKIPPED (why)`, the tool used, and the evidence (id, URL, or quoted value). Update it after every phase.
> 7. Phase 9 is cleanup. Do it even if earlier phases failed, then post the final summary table in chat.

---

## Phase 0 — Discovery (reads only, no approval)

| # | Step | Tool | Pass when |
|---|---|---|---|
| 0.1 | List sites and confirm the label, default flag, builder and channel policies | `wp_sites` | Site shows `builder: oxygen`, rest/mcp/cli all available |
| 0.2 | Run the full diagnostic | `wp_site_status` | Every row green; status `healthy`; MCP tools ≥ 50 |
| 0.3 | List MCP abilities, then filter to `oxygen` | `wp_mcp_tools` | Full list returned; oxygen abilities include site-info, instructions, and page/tree read + write abilities. **Record the exact names** — later phases use them |
| 0.4 | Read WP facts over CLI: `option get blogname`, `core version`, `plugin list --status=active --format=json`, `theme list --format=json` | `wp_cli` | JSON comes back; Oxygen + Agent Connector + LiteSpeed listed active |
| 0.5 | Read the site over REST: `/artivio/v1/site`, `/wp/v2/users/me?context=edit` | `wp_rest` | Base plugin reports version/builders; user has `administrator` |

**Phase pass:** all five green. If 0.3 returns no write-capable Oxygen abilities, stop — Phases 5–7 depend on them.

---

## Phase 1 — Read existing content

| # | Step | Tool | Pass when |
|---|---|---|---|
| 1.1 | List pages, then posts | `wp_content_list` (type page, then post) | Ids, slugs, statuses, links returned |
| 1.2 | Fetch one existing page in full | `wp_content_get` | Raw content returned; Noah notes whether `post_content` is empty (expected on Oxygen pages — layout lives in the builder) |
| 1.3 | Read that page's Oxygen layout via MCP | `wp_mcp` (the tree/read ability from 0.3) | A JSON structure with sections/elements comes back |
| 1.4 | Read the front page HTML from the outside | `fetch_url` | Page loads; title matches |

**Phase pass:** Noah can describe the site's pages and the structure of one Oxygen page from tools alone.

---

## Phase 2 — Content CRUD over REST

Snapshot first (`wp_snapshot`, note "phase 2").

| # | Step | Tool | Pass when |
|---|---|---|---|
| 2.1 | Create a draft POST `[ARTIVIO-TEST] Sunday Service Recap` with 3 paragraphs of HTML and an excerpt | `wp_content_create` | Returns id; status `draft` |
| 2.2 | Read it back and confirm content is intact | `wp_content_get` | HTML matches what was sent |
| 2.3 | Update: change title to `… Recap (edited)`, add a 4th paragraph, set slug `artivio-test-recap` | `wp_content_update` | Fields changed; untouched fields preserved |
| 2.4 | Publish it (this is the approval-gated write) | `wp_content_update` status `publish` | Public URL returns 200 and contains the 4th paragraph |
| 2.5 | Create a draft PAGE `[ARTIVIO-TEST] Plain Page` with plain HTML | `wp_content_create` type page | Returns id |
| 2.6 | Trash the post from 2.1 | `wp_content_trash` | Public URL now 404/redirect; post appears in trash via `wp_cli post list --post_status=trash` |
| 2.7 | Negative: try `wp_content_update` with `status:"trash"` | `wp_content_update` | Tool refuses with a message pointing at `wp_content_trash` (correct behaviour) |

**Phase pass:** 2.1–2.7 as stated. Leave the page from 2.5 for Phase 4.

---

## Phase 3 — Media

| # | Step | Tool | Pass when |
|---|---|---|---|
| 3.1 | Get an image into the workspace library: `search_stock_photos` "church stained glass" → `save_file_from_url` (free path first — no Kie credits) | `search_stock_photos`, `save_file_from_url` | Library file id returned |
| 3.2 | Upload it to the site's Media Library | `wp_upload_media` (library file id, never a URL) | WordPress media id + URL returned; `fetch_url` on the media URL returns an image |
| 3.3 | Set it as the featured image on the page from 2.5 | `wp_content_update` with `featuredMediaId` | `wp_rest GET /wp/v2/pages/<id>` shows `featured_media` = that id |
| 3.4 | Negative: call `wp_upload_media` with a URL instead of a file id | `wp_upload_media` | Tool refuses and explains |

**Phase pass:** 3.1–3.3 green, 3.4 refuses.

---

## Phase 4 — SEO

| # | Step | Tool | Pass when |
|---|---|---|---|
| 4.1 | Check which SEO plugin is active (`plugin list` from 0.4). If neither Rank Math nor Yoast is active, install + activate Rank Math: `wp_cli ["plugin","install","seo-by-rank-math","--activate"]` (approval) | `wp_cli` | Plugin active |
| 4.2 | Read SEO fields of the page from 2.5 | `wp_seo_get` | Fields returned with character counts (empty is fine) |
| 4.3 | Set title, description (≤155 chars), focus keyword "church stoney creek", robots `index,follow` | `wp_seo_update` | `wp_seo_get` shows the values; character counts correct |
| 4.4 | Clear the description with `""` | `wp_seo_update` | Description empty; title untouched |
| 4.5 | Verify from the outside after publishing the page | `wp_content_update` publish → `fetch_url` | `<title>` and `<meta name="description">` (re-set in this step) match |

**Phase pass:** SEO fields round-trip and appear on the live page.

---

## Phase 5 — Oxygen via MCP (the important one)

Snapshot first (`wp_snapshot`, note "phase 5"). Use the ability names recorded in 0.3; read Oxygen's own instructions ability before the first write.

| # | Step | Tool | Pass when |
|---|---|---|---|
| 5.1 | Read Oxygen instructions + site info abilities | `wp_mcp` | Noah summarises in 3 lines how Oxygen expects a page tree to be written |
| 5.2 | Create a new page `[ARTIVIO-TEST] Oxygen Page` (REST or MCP, whichever the instructions say) | `wp_content_create` / `wp_mcp` | Page id |
| 5.3 | Build a layout on it via MCP: one Section → Heading "Welcome to Noah United Church" + Text paragraph + a Button linking to `/contact` | `wp_mcp` (write ability) | Ability returns success; tree read-back shows the three elements |
| 5.4 | Style it: set the section background to brand purple `#74277C` and the heading colour to gold `#CE9621` — via Oxygen's CSS/variable or style ability | `wp_mcp` | Tree/styles read-back shows the values |
| 5.5 | Publish the page; flush cache; fetch the live URL | `wp_content_update`, `wp_cache_flush`, `fetch_url` | Live HTML contains the heading text AND the purple colour (search for `74277c` in the HTML/CSS) |
| 5.6 | Edit in place: change the heading text to "Welcome Home" | `wp_mcp` | Live page shows the new text after cache flush |
| 5.7 | Read an EXISTING Oxygen page tree (from 1.3) and add one Text element at the end, then remove it again | `wp_mcp` | Tree returns to its original element count; live page unchanged |
| 5.8 | Negative: attempt a write ability on a page id that does not exist | `wp_mcp` | Clean error, no side effects |

**Phase pass:** 5.3–5.7 green. This proves Noah can build and edit real church pages, not just post HTML.

> If a write ability in 5.3 is queued for approval and then refused by Oxygen, capture the exact ability name and payload — that is the `MCP_READ_RE` / ability-schema finding Ryan is waiting for.

---

## Phase 6 — WP-CLI maintenance

| # | Step | Tool | Pass when |
|---|---|---|---|
| 6.1 | Snapshot and confirm the file exists outside web root | `wp_snapshot` then `wp_cli ["eval","echo 1;"]` is NOT needed — use the returned path | Path returned; not under `public_html` |
| 6.2 | Cache flush | `wp_cache_flush` | Reports object cache, transients, rewrite rules, LiteSpeed purge |
| 6.3 | Search-replace DRY RUN `http://build.churchwebglobal.com` → `https://build.churchwebglobal.com` | `wp_search_replace` (dry_run default) | Per-table counts returned; nothing changed (`wp_cli option get siteurl` unchanged) |
| 6.4 | Plugin update check | `wp_cli ["plugin","list","--update=available","--format=json"]` | JSON (possibly empty) |
| 6.5 | Cron + rewrite sanity | `wp_cli ["cron","event","list","--format=json"]`, `["rewrite","list","--format=json"]` | JSON returned |
| 6.6 | Negative: attempt `wp_cli ["db","drop","--yes"]` and `["eval","system('ls');"]` | `wp_cli` | Both **refused by Artivio** before reaching the server (deny list) — this must not require approval to refuse |

**Phase pass:** 6.1–6.5 green, 6.6 refused.

---

## Phase 7 — Real church scenarios (end to end)

These are the tasks a church admin will actually ask for. Each is a mini-mission; Noah chooses the tools.

| # | Scenario | Pass when |
|---|---|---|
| 7.1 | "Add this Sunday's service times to the home page: 9:00 Traditional, 11:00 Contemporary." | Live home page shows the times, styled consistently with the page (Oxygen edit, not a raw HTML dump) |
| 7.2 | "Post the sermon 'Faith in Hard Times' by Rev. J. Smith with this summary (3 sentences Noah writes) and the stained-glass image as featured image; publish and share the link." | Post live with featured image; SEO title/description set without being asked |
| 7.3 | "Create a Staff page with three people (name, role, one-line bio) laid out as cards, purple/gold brand colours." | Page live; three cards; brand colours present in CSS |
| 7.4 | "The phone number on the Contact page is wrong — change 905-555-0100 to 905-555-0199 everywhere it appears." | Noah finds every occurrence (content + Oxygen trees), changes them, verifies live; reports where it was found |
| 7.5 | "Something looks cached — make sure visitors see the latest version." | Cache flushed, verification fetch done, plain-language confirmation |

**Phase pass:** all five completed with live verification and a human-readable summary each.

---

## Phase 8 — Safety and policy

| # | Check | Pass when |
|---|---|---|
| 8.1 | Every write in Phases 2–7 appeared in the Approvals inbox before running (channels are Ask first) | Ryan confirms from the inbox; Noah's note lists which calls were queued |
| 8.2 | No application password, SSH key, or `Authorization` header appears in any tool output, note, or chat message | Ryan searches the note and Activity log for `Basic `, `Bearer `, `PRIVATE KEY` |
| 8.3 | `Activity` on the site shows one row per call with an argument hash, not arguments | Ryan opens Activity |
| 8.4 | Noah never claimed success without an outside verification fetch | Spot-check three PASS lines in the note |

---

## Phase 9 — Cleanup and report

| # | Step | Tool |
|---|---|---|
| 9.1 | Trash every post and page titled `[ARTIVIO-TEST] …` (list first with `wp_content_list`, confirm the list in chat, then trash) | `wp_content_list`, `wp_content_trash` |
| 9.2 | Revert Phase 7 changes on pre-existing pages (service times, phone number, staff page → trash) unless Ryan says keep | `wp_mcp`, `wp_content_trash` |
| 9.3 | Delete the test media item: `wp_cli ["post","delete","<media id>","--force"]` (approval) | `wp_cli` |
| 9.4 | Cache flush, final outside fetch of home page = original state | `wp_cache_flush`, `fetch_url` |
| 9.5 | Post the summary table: phase, steps passed/failed, findings, snapshot paths | chat + `save_note` |

---

## Report format (Noah's final message)

```
WordPress capability test — build-churchwebglobal-com — <date>
Phase 0 Discovery ......... 5/5 PASS
Phase 1 Read .............. 4/4 PASS
Phase 2 Content CRUD ...... 7/7 PASS
Phase 3 Media ............. 4/4 PASS
Phase 4 SEO ............... 5/5 PASS
Phase 5 Oxygen MCP ........ x/8  (list any FAIL with ability name + error)
Phase 6 WP-CLI ............ 6/6 PASS
Phase 7 Scenarios ......... 5/5 PASS
Phase 8 Safety ............ (Ryan confirms)
Phase 9 Cleanup ........... done; snapshots at <paths>
Findings for Ryan: <bullets — anything refused, slow (>30 s), or that needed a workaround>
```

## What a failure most likely means

- **0.3 shows no Oxygen write abilities** → Agent Connector not exposing them; check the plugin's settings on the site.
- **5.3 write refused/queued forever** → the read/write classification (`MCP_READ_RE`) or the ability's input schema — send Ryan the exact name and payload.
- **5.5 heading present but colour missing** → Oxygen writes styles separately from the tree; the style ability from 0.3 wasn't used.
- **Any "HTTP 200 but failed"** → plumbing, not the site; report to Ryan verbatim.
- **6.6 reaches the server** → deny list regression; stop everything and tell Ryan.
