# Artivio Elementor Agent

A single-file WordPress plugin that exposes Elementor's page tree over the REST API, so Artivio's agent can read and edit layouts on a client site.

## Why this exists

Divi keeps its layout in `post_content`, which core WordPress REST already exposes — that is why the DiviOps MCP server needs nothing but a site URL and an Application Password.

Elementor keeps the entire page in **`_elementor_data`**, a postmeta key whose leading underscore makes it *protected*. Core REST will not read it and will not write it, on any site, with any credential. Through a plain WordPress connection an Elementor page looks like an empty post.

So there is no "just point an MCP at the site" version of this. This plugin is the bridge.

## Install (once per client site)

1. WP Admin → **Plugins → Add New → Upload Plugin** → upload `artivio-elementor-agent.zip` → **Activate**.
   (Or drop the folder into `wp-content/plugins/`, or `wp-content/mu-plugins/` for a must-use install that can't be deactivated by accident.)
2. WP Admin → **Users → Profile → Application Passwords** → create one, on an **Editor** account.
3. In Artivio: **Admin → Plugin catalog → Quick add → "Elementor (WordPress page builder)"**, then connect it in the workspace with the site URL and `username:application password`.
4. Ask the agent to run `elementor_status`. If it doesn't come back `ready: true`, nothing else will work — and the message will say which half is missing.

## Security

Every route requires an authenticated user with `edit_posts`; every route that names a document also checks `edit_post` on that specific post.

Element settings are **not** run through kses, because Elementor settings legally contain raw HTML (Text Editor widget, HTML widget, custom CSS) and filtering them would corrupt real pages. A caller holding these routes therefore has exactly the power of a person sitting in the Elementor editor — no more, but no less.

**Issue the Application Password to an Editor, never an Administrator, and revoke it when the engagement ends.**

## Routes

All under `/wp-json/artivio-elementor/v1`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/status` | Plugin + Elementor version, active kit, current user |
| GET | `/documents` | Pages, posts and library templates, flagged built-with-Elementor |
| POST | `/documents` | Create a page (always a draft) |
| GET | `/documents/{id}/outline` | Compact tree: ids, types, labels, depth-capped |
| GET | `/documents/{id}/tree` | Raw `_elementor_data` |
| PUT | `/documents/{id}/tree` | Replace the whole layout |
| GET | `/documents/{id}/elements/{el}` | One element's full settings |
| PATCH | `/documents/{id}/elements/{el}` | Merge settings (`replace: true` to overwrite) |
| DELETE | `/documents/{id}/elements/{el}` | Remove element and its children |
| POST | `/documents/{id}/elements` | Insert an element at a parent + index |
| POST | `/documents/{id}/elements/{el}/move` | Reparent / reorder |
| POST | `/documents/{id}/elements/{el}/duplicate` | Copy in place with fresh ids |
| GET | `/widgets` | Every widget registered on this site right now |
| GET | `/widgets/{name}/schema` | That widget's real control keys, types, defaults |
| GET | `/templates` | Saved Elementor library templates |
| POST | `/documents/{id}/apply-template` | append / prepend / replace |
| GET | `/kit` | Global colours, typography, container width |
| PATCH | `/kit` | Update the global kit (site-wide) |
| POST | `/flush-css` | Clear Elementor's CSS cache manually |

## The two gotchas this plugin exists to get right

1. **`_elementor_data` is written as `wp_slash( wp_json_encode( $tree ) )`.** `update_post_meta()` runs `wp_unslash()` on its input, so an unslashed JSON string loses every backslash in it. Pages whose settings contain `\n`, a unicode escape or a regex come back subtly broken — days later, with no error anywhere.

2. **Elementor serves a cached CSS file per post.** Write the tree without clearing it and the save succeeds, the editor shows the change, and the live page looks exactly as it did before. Every write route here ends in a cache flush; kit writes flush site-wide.

## Uninstalling

Deactivate and delete. The plugin stores no options and no tables of its own — it only ever reads and writes Elementor's own postmeta.
