# Content Placement Test Protocol

## Why this exists

"Content placement" has been scored twice tonight — 5/10, then later 6/10
— and both scores came from the same kind of untested self-report that
Test 1-6 proved wrong for the design-properties question. Nobody has
actually run a controlled test against `html-to-page`'s `position`
param, `wp_oxygen_replace`, the `move` op, or the `duplicate` op. Before
building anything to fix this dimension, find out what's actually broken
— it may turn out nothing is, the same way "design properties are
missing" turned out to mean "wrong tool was being called."

Run this on build2.churchwebglobal.com, same discipline as Test 1-6:
one exact operation per test, raw request/response reported (not just a
verdict), and **every claimed placement checked against the live
rendered page or `oxygen-get-post-tree` — never trust a `success: true`
alone.** Reset the test page to a known state before each test so
results aren't contaminated by the previous test's side effects.

## Setup

Create a fresh test page (or reuse #9 after restoring the DB snapshot)
with a known, simple structure — e.g. three top-level containers, each
holding one text element, in a known order (A, B, C). Record the
starting `oxygen-get-post-tree` output before Test 1 as the baseline to
diff every later result against.

## Test 1 — `html-to-page` with an explicit `position`

Call `html-to-page` with a new element and an explicit `position` value
targeting a specific index (e.g. "insert as the 2nd child of container
A", not appended at the end). Then:
- Call `oxygen-get-post-tree` and check the new element actually landed
  at the requested index, not appended to the end regardless of what
  `position` said.
- Repeat once targeting position 0 (start) and once targeting an index
  in the middle of an existing list, to rule out an off-by-one or
  "only works at the end" bug.

Report: the exact `position` value sent, the exact resulting tree order,
and whether they match.

## Test 2 — `wp_oxygen_replace`

This tool was flagged earlier as "not yet exercised in production."
Call it to replace one specific existing element's content/subtree
(not append, not delete-and-reinsert). Then:
- Confirm via `oxygen-get-post-tree` that only the targeted element
  changed and nothing around it duplicated, shifted, or got dropped.
- Repeat once on an element with children, to check the replace doesn't
  orphan or duplicate the children.

Report: before-tree, the exact replace call, after-tree, and a plain
yes/no on "only the intended node changed."

## Test 3 — `move` op

Move an existing element (e.g. container C) to a specific new position —
both a same-parent reorder (C moves before A) and a cross-parent move
(an element moves from inside A to inside B). Then:
- Confirm via `oxygen-get-post-tree` the element ended up exactly where
  requested, and that it was not duplicated (i.e. it no longer appears
  in its old location).
- Confirm sibling indices around both the old and new location are
  correct afterward (nothing shifted unexpectedly).

Report: before-tree, move call, after-tree, pass/fail on both checks.

## Test 4 — `duplicate` op

Duplicate an element that has children. Then:
- Confirm via `oxygen-get-post-tree` that the duplicate has fresh
  element IDs throughout its subtree (not reused IDs colliding with the
  original — this was the exact class of bug that caused duplication
  incidents earlier tonight).
- Confirm the duplicate's classes/variable-overrides (if any) carried
  over, and that editing the duplicate doesn't also change the original
  (proving they're not sharing state).

Report: before-tree, duplicate call, after-tree, ID-collision check,
independent-edit check.

## Test 5 — Cache/staleness control

For at least one of the above, immediately re-fetch the page via the
audit plugin's `cache_headers_seen` / `possible_stale_content` fields
right after the write, the same way Test 1-6 did for the design-property
question. If placement looks wrong, rule out a stale read before
concluding it's a real placement bug.

## Reporting format

Same matrix style as Test 1-6:

| Test | Operation | Requested | Actual (from get-post-tree) | Match? |
|------|-----------|-----------|------------------------------|--------|
| 1a | html-to-page position=0 | ... | ... | ✅/❌ |
| 1b | html-to-page position=mid | ... | ... | ✅/❌ |
| 2 | wp_oxygen_replace | ... | ... | ✅/❌ |
| 3a | move same-parent | ... | ... | ✅/❌ |
| 3b | move cross-parent | ... | ... | ✅/❌ |
| 4 | duplicate | ... | ... | ✅/❌ |

Whatever fails becomes a precisely-scoped bug (or a "wrong tool/wrong
parameter name" finding, like the design-properties question turned out
to be) instead of a vague "6/10, not fully trusted" score. That's what
determines whether `artivio-oxygen-agent` needs to wrap this dimension
at all, and if so, exactly what it needs to wrap.
