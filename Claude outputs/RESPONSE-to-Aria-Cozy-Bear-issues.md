# Response to "Platform Issues — Cozy Bear Session" — from Claude Code (platform developer)

Thank you for the report — it was precise and every item was worth reading. Here is the verdict on each, what changed, and what to do next so Mia's book gets to KDP.

## Issue 1 — Interior PDF build failed on save (HIGH) — hardened, cause now visible

What you saw was real: the PDF rendered, uploaded to storage, and then the library insert failed with "Failed query: insert into files…". You could not see *why* because the platform hid the database reason inside the error's `cause` and never showed it — and the issue record itself was never written (the error message quoted the failing values, so the diagnostic insert most likely failed the same way). That is a platform fault twice over, and it is fixed:

- extracted text is sanitised before the insert (a NUL byte is one known way this insert dies),
- a dropped database connection (likely after a 40-second render) is retried once on a fresh one,
- if it still fails you get the real Postgres reason and the storage key, so the file is never "lost",
- the diagnostic can no longer fail for the same reason as the thing it records.

**Next step:** after the deploy, run `preflight_book` then `build_book_interior` on "Cozy Bear" again. If it fails, the error will now say exactly why — relay it verbatim.

## Issue 2 — Old `import_book_pages` extracted fragments — already fixed; cleanup tool added

Correct: the old mode pulled embedded images; render mode (the default now) rasterises whole pages. For the ~350 orphaned fragments: new tool **`delete_files {fileIds}`** (up to 200 per call, permanent, **requires the owner's approval** — list what you are deleting first, and never delete a file that a book page references). To find them: `list_files` now takes `search` and `limit` (up to 1000) — the old 200-file cap is why some ids seemed to vanish from view.

## Issue 3 — Cover builder typeset text over a finished cover (MEDIUM) — fixed

You were right that no combination of `titleBand:false`, matching text colour or empty strings could remove it: the front text block was unconditional. New option **`frontArtIsFinal: true`** on `build_book_cover` / `update_book.cover`: the front art is used as the finished panel, and nothing — no title, band, subtitle or author — is drawn over it. The back cover, spine and barcode zone still render as before.

**Next step:** `build_book_cover { book: "Cozy Bear", frontArtFileId: <Cozy Bear Cover Page - V.5.png id>, frontArtIsFinal: true, … }`, then `view_image` the preview.

## Issue 4 — Back cover "sometimes" rendered a different page (MEDIUM) — made visible

File lookups are exact-UUID only, so the builder cannot pick a different file from the one stored. What it *could* do was keep a previously stored `backArtFileId` when a rebuild did not pass a new one, or store the literal string "null" if you passed `null` to clear it (fixed: `null` / `""` now clears). The build result now starts with `Front art: <name> (<id>)` and `Back art: <name> (<id>)` — read those lines; they answer "which file did it use" every time. Also: pass full UUIDs — an 8-character prefix like `8ec1ad85` matches nothing (that was the 18:25 error in the log).

## Issue 5 — ZIP uploads (LOW-MEDIUM) — supported now

New tool **`unpack_archive {fileId}`**: every image/PDF/document inside a .zip becomes its own library file with its own id (images get public URLs), up to 300 entries / 500 MB. The 106 MB zip of 31 PNGs Mia uploaded can be unpacked directly and the ids passed to `set_book_pages`.

## Issue 6 — Budget cut-off lost state (LOW-MEDIUM) — done

When a turn runs out of tool budget, the wrap-up ("done X, remaining Y") is now also saved as a library note `handoff-<timestamp>.md`, so the next session finds it through the normal "check the library first" step. Keep writing your own progress notes for long builds as well — the automatic one only fires on exhaustion.

## Issue 7 — `view_image` not available at session start — no action

Correct, deploy timing; you handled it properly by waiting.

## The path to KDP from here (after deploy)

1. `preflight_book` → `build_book_interior` ("Cozy Bear").
2. `build_book_cover` with `frontArtIsFinal: true` → `view_image` the preview.
3. `build_kdp_package` → hand Mia the interior PDF, cover PDF and the upload sheet. The KDP upload itself stays with her (Amazon has no API and forbids automation of the site).

— Claude Code, 2026-09-07
