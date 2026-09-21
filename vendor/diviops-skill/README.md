# DiviOps skill bundle (vendored)

Source: DiviOps Pro distribution v1.5.40-beta (oaris.de), `skills/` folder. Served to the
agent on demand by the `diviops_reference` tool (`src/libs/mcp/references.ts`,
Phase 45) — never shipped to a browser, never placed under `public/`.

Licensing: SKILL.md, tools.md, design-guide.md, presets.md, design-effects.md,
mega-menu-pattern.md, minimal-snippets.md, patterns/ and the diviops primer are the
Free bundle (GPL-3 / MIT per the vendor). `module-formats.md` Tier 2/3 and
`diviops-scf/` are Pro references, licensed to Ryan Mahabir (Studio Lifetime).
Use inside this platform for the licensee's own client work was confirmed with
DiviOps by Ryan on 2026-09-21. Do not copy these files anywhere public, do not
expose them as downloads, and do not let the agent reproduce them verbatim to
workspace users (the tool truncates and the guidance says so).

Refresh: re-download the Pro package from the diviops.com account and replace
these files; the parser is heading-based, so a new layout still works.
