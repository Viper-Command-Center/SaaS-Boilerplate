# Oxygen Builder — Agent Playbook

Last verified against **Oxygen 6.2.0-beta.8** (2026-09-09), base stack only
(Agent Connector for WP + Artivio Oxygen Audit v1.3.0 + Artivio Oxygen
Agent v1.0.0 + Artivio WP Agent base). No Respira, no Inhale, no
Universal Abilities needed or recommended — see "Why no third-party MCP
plugin" below.

**Oxygen ships a new 6.2 beta roughly every week.** Before trusting
anything below on a site, call `GET /wp-json/artivio-oxygen/v1/status`
— if `versionDrift` is `true`, re-run the relevant test in this document
before relying on old findings. Update `ARTIVIO_OXYGEN_AGENT_VERIFIED_AGAINST`
in the plugin after re-verifying.

## The core rule

**A tool call returning `success: true` is not proof anything changed on
the live page.** Every write in this playbook ends with an independent
check — `oxygen-get-post-tree`, `oxygen-preview-post`, or the audit
plugin — before reporting a task done. This is not optional caution; it
is what the entire Test 1-6 investigation was about, and it caught real
gaps (missing variable-override rendering) that a self-report alone
would have missed.

## Which tool for which job

| Job | Tool | Notes |
|-----|------|-------|
| Content (text, image URL, link) | `oxygen-edit-post` update op, `content.*` fields | Works reliably. |
| Element settings (id, attributes, tag) | `oxygen-edit-post` update op, `settings.*` fields | Confirmed working. |
| Styling scoped to ONE element | `oxygen-set-element-variable-overrides` | The correct tool for per-element design. NOT `design.*` on `oxygen-edit-post` — see below. Requires the variable's `id` (UUID), not just its `variable` name — call `oxygen-get-css-variables` first to resolve it. This is a two-call pattern, not one. If no matching variable exists in the registry, reuse or create a CSS class via `oxygen-insert-stylesheet` instead of forcing a new variable. |
| Insert a repeater/dynamic element (`PostsLoop`, `DynamicDataLoop`, `TermLoopBuilder`) | `html-to-page` | Requires an explicit `element_type` field — omitting it fails, unlike static elements. See "Static vs. dynamic elements" below. |
| Reusable class across many elements | `oxygen-insert-stylesheet` + apply via selector ID | Global scope by design — use for shared styling, not one-off. |
| Hover/state variants | Nested rules inside `oxygen-insert-stylesheet` | |
| Insert new element at a position | `html-to-page`, `position` param | Confirmed correct at index 0, middle, and (by extension) end. |
| Replace an element's content/subtree cleanly | `wp_oxygen_replace`, `operations` field (NOT `ops`) | Confirmed: no duplication, no orphaned children. |
| Reorder within same parent or move to a new parent | `move` op — fields are `parent_id` and `position` (NOT `new_parent_id`/`new_position`) | Confirmed both same-parent and cross-parent moves. |
| Clone an element (with children) | `duplicate` op | Confirmed: fresh element IDs throughout the subtree, no collision with the original, editing the copy never touches the original. |
| Verify page structure without a browser | `oxygen-get-post-tree` | Ground truth for every placement check in this document. |
| Verify a build renders without a browser | `oxygen-preview-post` | Use this AND the audit plugin, not just one. |

### Why `design.*` on `oxygen-edit-post` doesn't work

This isn't a bug. Across all 21 registered Oxygen 6.2 element types,
`properties.design` is legitimately empty in the schema — Container,
Text, Image, RichText, every one of them. Oxygen 6.2's per-element
design model runs through **CSS custom-property overrides**
(`oxygen-set-element-variable-overrides`), not inline property writes.
Do not file this as a bug again; do not waste a test cycle rediscovering
it. If a future beta changes this, `/status`'s version-drift flag is
the signal to re-check.

### Static vs. dynamic elements — a real architectural split

Confirmed at real depth/scale (5 levels, 207 elements, church homepage
build, 2026-09-09): **static/layout elements and repeater elements are
NOT styled the same way.**

- Static elements (Container, Text, Image, RichText, ContainerLink,
  SvgIcon2, and other layout types) legitimately have an empty
  `design` schema — style them via `oxygen-set-element-variable-overrides`
  or a shared class from `oxygen-insert-stylesheet`. This was the Test
  1-6 finding.
- Repeater/dynamic elements (`PostsLoop` confirmed; `DynamicDataLoop`
  and `TermLoopBuilder` not yet tested but expect the same) have a
  **fully populated `design` schema** — layout, grid, slider, accordion,
  tabs, pagination, filter_bar are all real writable properties on
  these element types directly. Don't reach for a variable override on
  a repeater before checking whether the property you want is just a
  native `design.*` field on that element.
- Inserting a repeater requires an explicit `element_type` field on
  `html-to-page` — omitting it fails outright, unlike static elements
  where it can be inferred. Always set it explicitly for these.

## Verification checklist (run after every write)

1. **Placement changes** (insert, move, duplicate, replace): call
   `oxygen-get-post-tree` and diff against what was expected — not just
   "it returned success."
2. **Design changes** (variable overrides): call the audit plugin's
   `GET /verify-variable-override/{post_id}?element_id=&variable=&expected_value=`
   — confirms the variable actually reached the rendered page (inline or
   in CSS), whether the value matches, and whether anything even
   consumes it via `var(--name)`. A variable set but never referenced
   has no visible effect even though the write succeeded.
3. **Class/CSS changes**: call the audit plugin's
   `GET /audit-page/{post_id}` (and `?debug_class=<name>` if a specific
   class needs tracing) plus `GET /unused-classes/{post_id}` before
   writing new CSS — a matching class may already exist from an earlier
   attempt.
4. **Anything before a risky write**: `POST /wp-json/artivio-oxygen/v1/snapshot/{post_id}`
   first. If verification in steps 1-3 comes back wrong,
   `POST /wp-json/artivio-oxygen/v1/restore/{post_id}` with that
   snapshot_id — restoring itself always takes a fresh snapshot first,
   so a bad restore is never a dead end.

## Known platform quirks (build2.churchwebglobal.com, this stack)

- A newly-activated plugin's REST routes can 404 until the object cache
  is flushed — flush cache and retry before concluding a route is
  broken.
- `oxygen-get-post-tree` and the WP-CLI plugin-list call have both hit
  transient platform bugs during testing, auto-reported to Artivio.
  Retry once before treating either as a real failure.
- Tool count on this stack: 47 (base) / 44 (after Inhale removed — some
  of the 47 were Inhale's). Compare against a fresh
  `wp-mcp-tools` call if a count looks off.

## Why no third-party MCP plugin (Respira / Inhale / Universal Abilities)

A controlled five-configuration test (base only, +Universal Abilities,
+Inhale, both together, Respira commercial alone) found **zero
difference** in the `oxygen-edit-post` write behavior across all five.
The abilities in question are registered by Oxygen itself
(`Source: oxygen`), not by any transport plugin. None of the three
third-party options add anything this stack needs, and
"Universal Abilities for Agent Connector" specifically exposes shell
exec / PHP eval / WP-CLI / wp-admin login over MCP — a security surface
with no offsetting benefit here. Keep it deactivated unless a specific,
verified need arises.

## Outstanding / not yet verified

- Content placement is now confirmed at real complexity: a full 6-section
  church homepage, 5 levels deep, 207 elements, built and verified via
  tree diffs at every step (2026-09-09, build2.churchwebglobal.com,
  page 115). `PostsLoop` specifically confirmed working with the caveats
  above. `DynamicDataLoop` and `TermLoopBuilder` are assumed to behave
  the same way as `PostsLoop` but have not been individually tested —
  don't treat that as proven until one is actually exercised.
- Known real constraints found at this scale (none are blockers, all
  are documentable): inline style writes can drop under volume — verify,
  don't assume, on any page with many styled elements in one session;
  the variable-override write is a two-call pattern (`oxygen-get-css-variables`
  then `oxygen-set-element-variable-overrides` with the resolved `id`);
  the audit plugin's `audit-page` can report false positives from
  site-wide header/footer content bleeding into a single page's results
  (see "Known audit plugin gap" below).
- Concurrent multi-agent edits to the same page were attempted but not
  completed in this test run — still genuinely untested. Needs a
  deliberate two-session test on a disposable page before this is
  called safe or unsafe either way.

## Audit plugin: header/footer flags now labeled by region (fixed in v1.4.0)

`GET /audit-page/{post_id}` walks the full rendered DOM, which includes
the site's global header/footer template — content from those regions
(e.g. site-wide markup from post 50) used to show up as flags on
unrelated per-page audits (e.g. page 115) with no way to tell it apart
from a real per-page issue. **Fixed in v1.4.0**: every flag now carries a
`region` field (`header`/`footer`/`nav`/`main_content`), the response
reports an explicit `elements_flagged_main_content` /
`elements_flagged_global_regions` breakdown, and `?exclude_global_regions=1`
filters the list down to the page's own content when global chrome noise
isn't relevant. Region detection is heuristic (ancestor `<header>`/
`<footer>`/`<nav>` tags or common id/class markers) — an unrecognized
theme falls through to `main_content` by default, so nothing is silently
hidden. Update the running `artivio-oxygen-audit` install to v1.4.0
before relying on this.
