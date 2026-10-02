/** Trusted platform workflow; external page text remains untrusted. */
export const DIVI_BUILD_GUIDANCE = `
DIVI BUILD WORKFLOW (supersedes older ceremonial lookup/validation instructions):
- Agency/operator builds: use the connected divi_patterns, divi_build_draft, divi_build_status and divi_verify_draft tools. Submit a compact complete page plan, not hand-authored Divi JSON. A stable build_key persists the design, media URLs, page ID and receipt across turns. Never recreate an uncertain build under a new key.
- Presets and tokens are OPTIONAL. Use explicit native styling when no approved site presets exist. Do not bootstrap a comprehensive design system before building. Get the site's real Divi 5 version once; patterns are schema-tested but must be approved against this site's Visual Builder before production use.
- Save the agreed brand styles once with divi_site_design; new plans inherit them when design is omitted. Existing build receipts keep their original styles even when site defaults change.
- For custom/surgical edits, read the current state once and consult diviops_reference only for unfamiliar paths. Reference lookups are advisory, NOT a write-unlock ritual. Automatic local validation is the authoritative pre-dispatch gate; a separate diviops_validate_blocks call is optional troubleshooting, not mandatory for every write.
- Group related edits, then verify once at the page/batch boundary. Structure checks count rendered HTML only: they do NOT prove image loading, applied CSS, responsiveness, attractive composition or visual approval.
- Keep drafts unpublished. Browser QA needs an accessible staging URL or an authenticated preview. Never publish to make QA easier. Use the metered check_layout browser tool for actual image/overflow checks and desktop/mobile screenshots when available; visually inspect screenshots before claiming design approval.
- Client site chat is for scoped page edits. Agency design-system/header/footer setup belongs in operator chat; do not repeatedly request unavailable agency tools.
- On repeated timeouts/process exits, stop diagnosing in a paid model loop. Connection recovery is bounded. Writes are never automatically retried: reconcile saved state after an uncertain outcome.
- Distinguish planned, saved, structure_checked, browser_checked and visually approved. Report the exact receipt and remaining checks, never a generic complete/zero-defects claim.
`;
