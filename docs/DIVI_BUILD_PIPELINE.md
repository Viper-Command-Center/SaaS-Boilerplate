# Divi draft build pipeline

## What changed

Agency/operator chat now gets five small tools on each enabled DiviOps connection:
`divi_patterns`, `divi_site_design`, `divi_build_draft`, `divi_build_status`, `divi_verify_draft`.
Names are connection-namespaced like other MCP tools. Client site chat cannot
see or execute these tools. Constituent DiviOps operations must already have
`auto` policy; the pipeline never bypasses approvals/denials.

Eight versioned native patterns compile a compact plan into editable Divi 5
blocks. Explicit responsive styling is supported; presets are not prerequisites.
These patterns are locally schema-tested, **not certified against a live site's
Visual Builder**. Verify them on staging before production use.

## Example plan

Call the connected `divi_build_draft` with `dry_run: true` first to see block counts:

```json
{
  "build_key": "homepage-v1",
  "dry_run": true,
  "plan": {
    "title": "Home",
    "slug": "home",
    "builderVersion": "5.4.1",
    "design": {
      "primary": "#4338ca",
      "heading": "#0f172a",
      "body": "#334155",
      "font": "Arial, sans-serif"
    },
    "sections": [
      {
        "pattern": "hero-centered",
        "title": "Welcome to our community",
        "body": "Source-approved introductory copy.",
        "button": { "text": "Contact us", "url": "/contact" }
      },
      {
        "pattern": "feature-grid",
        "title": "How we help",
        "items": [
          { "title": "Connect", "body": "Approved service description." },
          { "title": "Participate", "body": "Approved event description." },
          { "title": "Support", "body": "Approved outreach description." }
        ]
      }
    ]
  }
}
```

Replace the example builder version with the site's actual installed Divi 5
version. Upload images to the target site's media library first and use the
returned URLs. Copy fields are plain text (paragraph breaks are preserved), not
raw HTML. The compiler caps pages at 12 sections and the existing 200-block /
400 KB write limits. Large pages must be split using the existing section tools.

Save agreed brand styles once using `divi_site_design {design: {...}}`. Subsequent
page plans inherit them if `design` is omitted; existing receipts preserve the
original styles. This is a platform manifest, not Divi preset creation.

Remove `dry_run` to create **one new draft**. This tool never publishes and never
overwrites an existing page. Reusing the same key and plan reads the receipt and
saved content instead of recreating a page. A different plan requires a new key;
use existing targeted module/section tools for edits to an existing draft.

## Durable receipts / recovery

Migration `0035_divi_build_pipeline` adds tenant/connection-scoped `divi_builds`.
The receipt stores the page plan (including brand and media URLs), page ID,
content hash, status and checks. A compare-and-swap claim prevents simultaneous
turns from creating the same build twice. Target changes refuse resume.

States: `planned`, `creating`, `uncertain`, `saved`, `structure_checked`,
`review_required`. An uncertain create is **not replayed**. Inspect the site's
pages and call `divi_build_status` with the same `build_key` and
`reconcile_page_id`; it binds only an exact matching unpublished draft.
Conflicting content requires manual review and is never overwritten.

Safe read calls have at most one retry after a timeout/process exit. A rate
limit or repeated transient failure opens a 30-second circuit. Writes are never
automatically replayed. Authentication/input failures are not retried.

## Verification and costs

`structure_checked` means readback matched and Divi returned module HTML. It
does **not** prove image downloads, responsive layout or aesthetics.

The existing metered AgentCore `check_layout` now checks visible image loading
and can save screenshots at desktop/tablet/mobile widths with `screenshots:true`.
Use `view_image` on returned file IDs and compare to the brief. Browser checks
require an accessible staging URL; the browser does not log in to WordPress or
make unpublished drafts public. If preview authentication is unavailable, use
owner preview review and explicitly leave browser verification pending.

Screenshots require workspace file storage; failures are reported as
`storage_unavailable`, not visual approval. Measurement cannot certify all
contrast/overlap issues or aesthetic quality. Visual approval remains a separate
human/vision review, not an automatic zero-defects claim.

The build tool writes internal audit rows and elapsed-time/logical-call receipts; existing usage events measure model
tokens and browser seconds. Benchmark a representative staging homepage using
those records before claiming a speed or cost reduction. No live benchmark has
been performed as part of this implementation.

## Rollout

1. Run the normal deployment migration step (`npm run db:migrate`). Do not run
   it against production merely to test locally.
2. Confirm DiviOps's installed plugin supports the bundled server's page tools.
3. Enable underlying page-create/get/render operations only where already
   authorized; do not change client policies globally.
4. Build a staging homepage, inspect desktop/mobile screenshots and reopen in
   Visual Builder to test editability and style preservation.
5. Measure time, tokens, refusals, outages and remaining defects.

Presets, full-site publication, global header/footer changes and automatic
authenticated browser login are deliberately not performed by these tools.
This is a page-level agent tool integrated with the existing mission runner, not
a new automatic multi-site/background scheduler or build-dashboard UI. It does
not dynamically switch reasoning models within a turn. Contrast/overlap checks,
automatic visual approval and real-site performance benchmarks remain rollout
work, not guarantees from local schema tests.