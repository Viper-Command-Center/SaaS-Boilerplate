# Platform & Builder Decision — DUDA-to-WordPress Migration at 200-Site Scale

For Ryan / Wayne / Chad / developer. Combines your own documented in-house experience (Oxygen, Elementor, DiviOps) with fresh research on Bricks Builder and non-WordPress Hostinger alternatives, done specifically to answer this decision honestly before it's locked in.

## Part 1 — Is WordPress even the right foundation?

Checked before assuming yes. Verdict: **yes, and it's not close.**

Hostinger's own non-WordPress products were the most promising alternative on paper (already on your hosting, no new vendor relationship) and they don't hold up for this use case:

- **Hostinger Website Builder** and **Hostinger Horizons** (their AI site builder) have **no public API for page/content creation** — Hostinger's own API docs cover Hosting, Domains, DNS, Email, VPS, WordPress, Ecommerce, and Billing only. Neither Builder nor Horizons is in that list.
- Horizons specifically is chat/UI-driven, one project at a time, with plan tiers capped at 1–50 *concurrent projects per account* — built for a solo non-technical user making one site, not an agency backend driving 200 tenant sites.
- Other CMSs Hostinger auto-installs (Joomla, Drupal, GRAV, ClassicPress, etc.) exist, but none has WordPress's depth of REST API/WP-CLI tooling or AI-agent ecosystem maturity. Drupal's headless JSON:API is genuinely solid, but it's not a natural fit for "simple church site with a page builder" and would mean rebuilding everything Artivio has already built for WordPress from zero.
- Ironically, **DUDA itself is the most agency/API-native platform of anything looked at** — it explicitly markets bulk automation and agency tooling. That's not a reason to stay on DUDA (the reasons you're leaving — dated output, manual-heavy workflow, weak AI capability — stand), but it's worth naming so the choice to move to WordPress is made with eyes open: you're trading DUDA's agency-native API for WordPress's much larger ecosystem and AI-tooling maturity, at the cost of DUDA's built-in bulk-management conveniences.

**Conclusion: WordPress remains correct.** The open question was never really "WordPress or not" — it's which builder sits on top of it.

## Part 2 — The builder comparison

Four builders, one honest table. Storage format matters because it determines whether a plain REST API write works, or whether special tooling is required — this is the exact mechanism that caused the Erindale failure.

| | **Oxygen** (current) | **Elementor** | **Divi 5** | **Bricks** |
|---|---|---|---|---|
| **Storage** | Separate builder-specific data, not `post_content` | `_elementor_data`, protected postmeta | `post_content`, but Gutenberg-block-JSON format (changed from Divi 4's shortcodes) + required protected postmeta | Postmeta (`_bricks_page_content_2` etc.), PHP-serialized JSON, flat parent/child structure |
| **Official vendor API/automation** | None — relies on third-party "WordPress MCP Adapter," requires Oxygen ≥6.1 (beta) | None — you built your own (`artivio-elementor-agent`) | None — a community project (`divilovewp/divi5-skill`) reverse-engineers the format, explicitly "untested" in parts | **Yes — native, vendor-shipped.** Bricks 2.4 (beta, 2026) ships official AI/MCP integration on the WordPress Abilities API + Automattic's own MCP Adapter, with a dedicated admin screen for AI permissions |
| **Your actual experience** | Beta core software, schema bugs you had to report upstream, high call-count per page (3-4+ calls), and the Erindale catastrophic failure | Built once (Phase 31), well-documented, "much easier" per your own account | Not yet built in your stack | Not yet built in your stack |
| **Vendor stability** | Oxygen 6 is beta software — you're automating against a moving target | Mature, stable | Just went stable Feb 2026 after a multi-year rewrite — young in its new form | Independent, bootstrapped, active (2.4 beta shipped 2026); no evidence found of an ownership controversy — worth telling me the source if you saw one, I couldn't confirm it |
| **License at 200 sites** | Per your existing purchase | Agency tier, custom-quoted, no flat unlimited price found | $249 lifetime, unlimited sites | **$599 lifetime, unlimited sites** |
| **Biggest risk** | Proven fragile under automation — today's failure, plus the earlier LiteSpeed-cache false-negative, plus a vendor schema bug you had to report | None documented beyond normal integration work | REST writes need protected-meta registration to actually render — not the "simple" story originally assumed; new block format means any assumptions from Divi 4 experience don't carry over | MCP feature is **brand new** (beta) — zero track record, unknown tool-call efficiency, unknown edge cases at real scale |

## Part 3 — The finding that actually changes the decision

Going in, this looked like a three-way comparison among builders you already have scar tissue with. It isn't anymore. **Bricks shipped official, vendor-built AI/MCP integration in 2026** — not a plugin you have to build (like Elementor), not a third-party adapter running on beta core software (like Oxygen), not a community project admitting untested edges (like Divi 5). The vendor built the automation layer themselves, on WordPress's own official Abilities API, with a real permissions UI.

That's structurally the best position of the four — *if* it holds up in practice. It's also the newest and least proven: it's beta, shipped in 2026, with no independent track record of anyone running it at your kind of scale. The honest read is that Bricks is the most promising candidate on paper and the biggest unknown in practice, in the same breath.

## Part 4 — What I'd actually do

Given "this decision is final and affects 200 customers," I would not make this call from a comparison table alone — and I don't think you should either. I'd run one bounded, real test before locking anything in:

1. **Pick one real church site** (Erindale is already extracted and ready — no need to redo that work).
2. **Migrate it three ways**: Bricks (via its native MCP), Elementor (your existing, proven agent), and Divi 5 (using the community skill, accepting it's unofficial). Skip Oxygen for this test — your own history already gives you enough signal there.
3. **Measure, not vibe**: tool calls per page, defect rate on first pass, time to a clean result, and how each behaves when run *unsupervised* through your mission pipeline (not hand-held) — since that's the condition that actually matters at 200 sites, and the condition Oxygen failed under.
4. Decide from those numbers.

That's a few days of work against a decision you're about to lock in for 200 customers — worth the delay. If you want, I can write the mission instructions for that three-way test the same way I wrote the DUDA extraction prompt, so it's ready to hand to Noah.
