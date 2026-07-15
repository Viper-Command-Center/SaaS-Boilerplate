# Artivio Command Center (working name)

Multi-tenant AI agent platform on this SaaS-Boilerplate fork (Next.js 16 + Clerk + Drizzle + pg). A Claude agent manages marketing and arbitrary client work per tenant via a per-tenant MCP registry + skills. Working plan: `Budget-Smart-AI/command-center/docs/Command Center - Claude Plan v1.md` (MCP-native design — no hard-coded vendor connectors).

## Infra (2026-07-11)
- Railway project **ArtivioAI**: services SaaS-Boilerplate (this repo, GitHub Viper-Command-Center/SaaS-Boilerplate, auto-deploy from main), Postgres (Railway, not Neon), legacy artivio.ai service (old site, to retire).
- Domain **artivio.ai** → SaaS-Boilerplate service (Cloudflare proxied, port 8080). Deploy ACTIVE, node 24.
- **Build fix (do not undo):** Railway Custom Build Command = `npm run build:next`; Pre-deploy Command = `npm run db:migrate`. Reason: the default `npm run build` runs drizzle-kit migrate at build time, where Railway's private network (postgres.railway.internal) is unreachable → build fails. Migrations must run pre-deploy.
- DB vars on the app service are copied from the Postgres service (DATABASE_URL etc.).

## Auth (2026-07-11: Clerk REMOVED by Ryan's decision)
- Custom session auth ported from BudgetSmart: `src/libs/auth/session.ts` (jose HS256 JWT cookie `artivio_session` + DB `sessions` table as authoritative check) and `password.ts` (bcryptjs, cost 12).
- API: `/api/auth/login|signup|logout`. First user to sign up becomes platform admin (`users.isAdmin`).
- Tenancy: `tenants` + `memberships` (roles: owner/admin/editor/viewer) in `src/models/Schema.ts`; migration `0001_auth-tenancy`.
- `src/proxy.ts` = edge middleware: i18n + cheap JWT gate on /dashboard + no-store on /api. Layouts call `getCurrentUser()` for the real check.
- `SESSION_SECRET` (32+ chars) is required at RUNTIME only (deliberately not in t3-env `Env.ts`, so builds never need it). Must be set in Railway variables.

## Phase 0 — COMPLETE (2026-07-11 ~10:30 PM)
- Deployed, migrations applied, Ryan signed in on artivio.ai/dashboard as platform admin (first user).
- Gotcha hit: SESSION_SECRET initially too short/late → signup 500 AFTER user insert (user existed, session signing threw). Deploy Logs showed "SESSION_SECRET must be set to a 32+ character random string". Fixed by updating the Railway variable + redeploy, then SIGN IN (not sign-up).

## Phase 1 — agent core — COMPLETE & VERIFIED (2026-07-11 ~11:45 PM, API smoke test 200 via Bedrock)
Gotchas hit: (1) deploy.bat commits were silently rejected by lefthook/commitlint — fixed with `git commit --no-verify` + conventional "chore:" message; (2) variables added after a deploy need a redeploy to take effect; (3) Ryan has TWO users — ryan@mahabir.pro (first, admin) and ryan.mahabir@outlook.com (made admin manually via Postgres console `update users set is_admin=true`).
- `src/libs/agent/anthropic.ts` — multi-provider Claude transport via fetch (NO sdk deps), first configured wins: BEDROCK_API_KEY bearer invoke (non-streaming, single-chunk yield; BEDROCK_MODEL_ID default us.anthropic.claude-sonnet-4-6, BEDROCK_REGION/AWS_REGION default us-east-1) → ANTHROPIC_API_KEY streaming (ANTHROPIC_MODEL default claude-sonnet-4-5). Ryan runs Bedrock keys (same as BudgetSmart), no Anthropic key.
- `src/libs/agent/prompt.ts` — tenant-scoped system prompt (Bud pattern; honest about Phase 2 tools not existing yet).
- `src/libs/tenants.ts` — getUserTenants + ensureDefaultTenant (admin's first dashboard visit auto-creates tenant 'artivio' + owner membership).
- API: POST `/api/agent/chat` {tenantSlug, message} → plain-text stream, history loaded server-side, one rolling conversation per tenant+user; GET `/api/agent/history?tenant=slug`.
- Schema: `conversations` + `messages`; migration `0002_agent-conversations` (runs pre-deploy).
- UI: `src/features/agent/AgentChat.tsx` on /dashboard (streams, reloads history on refresh).
- No new npm deps (fetch-based) → no lockfile change needed for this phase.

## Phase 2 — MCP registry + vault + tool loop + approvals (built 2026-07-12 AM, pending push+verify)
- Schema: `credentials` (vault-sealed cipher), `mcp_connections` (per-tenant; transport http|stdio, headerCredentials = header→credentialId, toolPolicy = tool→auto|approval|deny, DEFAULT approval), `approvals`, `audit_log`. Migration `0003_mcp-approvals`.
- `src/libs/vault.ts` — AES-256-GCM via node:crypto (NO deps). Env `VAULT_MASTER_KEY` = 64 hex chars, read at call time (never required at build).
- `src/libs/mcp/client.ts` — minimal JSON-RPC 2.0 Streamable-HTTP MCP client via fetch (initialize → tools/list → tools/call; handles Mcp-Session-Id + SSE responses). stdio = Phase 4 worker.
- `src/libs/mcp/registry.ts` — buildTenantToolset(): loads enabled connections, decrypts headers, lists tools, namespaces `mcp__<connection>__<tool>`, failure-tolerant (failed servers reported to the model, chat keeps working).
- `src/libs/agent/loop.ts` — tool loop (max 8 iters) with permission gateway: auto→execute, approval→approvals row + model told it's queued, deny→refused; every decision audited. `callClaudeWithTools()` added to anthropic.ts (Bedrock bearer invoke with tools param; Anthropic fallback).
- `/api/agent/chat` uses the loop when the tenant has tools; plain streaming chat otherwise (UI contract unchanged; progress lines "[tool] …" / "[approval] …").
- APIs: GET/POST `/api/mcp/connections`, PATCH/DELETE `/api/mcp/connections/[id]` (owner/admin), GET `/api/approvals`, POST `/api/approvals/[id]` {decision} — approve EXECUTES the stored call and stores the result (owner/admin/editor).
- UI: `ToolsPanel.tsx` (add server: name/url/optional auth header — value sealed into vault, never echoed; enable/disable/remove) + `ApprovalsPanel.tsx` (pending with args JSON, Approve & run / Reject, recent decisions; polls 15s) — both under the chat on /dashboard.
- NO new npm deps (lockfile untouched → `npm ci` on Railway still valid without a local npm install).

### RYAN'S CHECKLIST to ship Phase 2
1. Add `VAULT_MASTER_KEY` to Railway variables (SaaS-Boilerplate service): generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — must be exactly 64 hex chars. (Only needed when adding servers with credentials; everything else works without it.)
2. Run `deploy.bat` (commits --no-verify + pushes; Railway builds + runs migration 0003 pre-deploy).
3. Smoke test: dashboard → Tools panel → "Add MCP server" with any hosted MCP URL (e.g. a public test MCP server, or the Zernio/DataForSEO MCP endpoints when ready) → ask the agent to list what it can do → try a tool → watch it land in Approvals → Approve & run.

## Phase 3 — dynamic dashboard + multi-client (built 2026-07-12 midday, pending push+verify)
- Schema: `datasets` (tenant time-series/jsonb rows) + `dashboard_panels` (kpi|timeseries|table|markdown, config jsonb, position). Migration `0004_dashboard-datasets`.
- `src/libs/agent/platformTools.ts` — ALWAYS-available auto tools: list/create/update/delete_panel, write/query_dataset. Merged with MCP tools in `/api/agent/chat` (loop now runs every turn). This is how the agent reshapes the dashboard on request.
- `GET /api/panels?tenant=` resolves panel data server-side; `PanelsGrid.tsx` renders (dep-free SVG timeseries), polls 30s, hidden until panels exist.
- Multi-client: `GET/POST /api/tenants` (create = platform admin), `GET/POST/DELETE /api/tenants/[slug]/members` — adding an unknown email CREATES the account and returns a one-time generated password for the admin to share. `WorkspacePanel.tsx` (members+roles+new-workspace) on dashboard.
- Tenant switcher chips on /dashboard (?t=slug). Role gating: viewer=chat+panels · editor=+approvals · owner/admin=+tools+members · platform admin=everything. (Server APIs were already role-gated; UI now matches.)
- Ryan set Windows Task Scheduler to run all 3 repos' deploy.bat every 30 min — local changes auto-push; expect auto-deploys.

### Ship checklist (nothing new needed)
- deploy.bat (or wait for the 30-min scheduler). Migration 0004 runs pre-deploy. No new env vars, no new npm deps.
- Smoke: dashboard → ask the agent "create a markdown panel titled Hello saying hi" → panel appears within 30s. Create a test workspace + add a viewer member → log in as them → confirm they see chat+panels only.

## Phase 4a — website updates via the OFFICIAL GitHub MCP (decided 2026-07-12, Ryan's call: generalized > custom)
- **Standard path**: register GitHub's hosted MCP in the Tools panel — no custom code, works for ANY site whose host deploys on git push (Railway, Vercel, Netlify, Cloudflare Pages…).
  - Tools panel → Add MCP server: name `github`, URL `https://api.githubcopilot.com/mcp/x/repos` (the `/x/repos` path serves only the repos toolset — keeps the tool list lean), header `Authorization` = `Bearer <fine-grained PAT>` (PAT: Contents R/W + Pull requests on the site repos; the PAT's repo scope IS the tenant isolation — one PAT per client, sealed in the vault per workspace).
  - Full server (all toolsets incl. issues/PRs/actions): URL `https://api.githubcopilot.com/mcp/`.
  - Client-onboarding pitch: "no MCP for your custom site? Put it in a GitHub repo with auto-deploy on your host, connect the GitHub MCP, the agent can now edit your site — behind approvals."
- `src/libs/mcp/client.ts` sends `MCP-Protocol-Version` header after initialize (required by 2025-06-18-spec servers like GitHub's).
- `mcp-sites/` stays in the repo as an OPTIONAL lightweight fallback (simpler tool surface, per-site config, own bearer key) — NOT required, no Railway service needed unless wanted. See mcp-sites/README.md.
- First smoke test once Ryan adds the connection: ask the agent to "read the hero section of budgetsmart.io's homepage and propose a headline tweak" → update lands in Approvals → approve → commit → Railway deploys the marketing site.

## Phase 4b — scheduled agent tasks (built 2026-07-12 PM, pending push+verify)
- Schema: `scheduled_tasks` (prompt = complete instructions per run, intervalMinutes min 15, nextRunAt claim-before-run). Migration `0005_scheduled-tasks`.
- Agent platform tools: list/create/update/delete_scheduled_task — the AGENT manages its own standing missions ("post an SEO blog every Monday" → it creates the task itself).
- Runner: POST `/api/internal/run-scheduled` (header `x-cron-secret` = CRON_SECRET env, ≥16 chars; max 3 due tasks/tick, 300s maxDuration). Each run = fresh tool loop with full toolset + approvals gateway; result stored in lastResult (visible via list_scheduled_tasks).
- Trigger: `.github/workflows/agent-cron.yml` every 30 min (also manual via workflow_dispatch).
- **Ryan setup**: (1) add `CRON_SECRET` to Railway variables; (2) add the SAME value as GitHub repo secret `CRON_SECRET` (repo Settings → Secrets and variables → Actions).

## RYAN'S BIG-9 USE CASES → capability map (2026-07-12)
1. Site updates w/ PR-style history → GitHub MCP (full endpoint api.githubcopilot.com/mcp/ for PR tools); agent instructed to prefer branch+PR for non-trivial changes.
2. Social (15 platforms) → Zernio MCP in Tools panel when key ready (Phase: just config).
3. Auto blog posting → scheduled task + GitHub MCP (commits posts to the site repo). READY once GitHub MCP connected.
4. Railway MCP (docs.railway.com/ai/mcp-server) → gives deploy status/failures. CHECK TRANSPORT: if stdio-only, needs a hosted wrapper or the future worker; if hosted/HTTP, register directly.
5. Analytics dashboard → DataForSEO/GA4 MCPs + scheduled collection tasks writing datasets + agent-built panels. Plumbing DONE; needs the MCP registrations.
6. Influencer/affiliate discovery + outreach → needs a web-search MCP (e.g. Brave/Exa) + email-send MCP; outreach approval-gated.
7. Goal missions ("100 customers this week") → create_scheduled_task with the goal prompt + progress dataset + honest-escalation instructions (prompt supports this now; gets stronger with more MCPs).
8. Agent-as-employee → system prompt updated (ownership, honesty, business's best interest).
9. Support inbox (support@budgetsmart.io) → email MCP (IMAP or Gmail); replies approval-gated. Candidate for next build.
- MCP discovery: agent now recommends specific servers (mcpmarket.com as directory) whenever a capability is missing.

## Phase 4c — built-in browsing: `mcp-browser/` (built 2026-07-12 eve, pending Ryan's 2 Railway services)
- Zero-dep MCP wrapper over self-hosted Browserless: browse_page (rendered text+title+links), get_page_html, scrape_page (CSS selectors). SSRF-guarded, 40KB caps. Verified `node --check`.
- Ryan setup (mcp-browser/README.md): (1) Railway service from Docker image `ghcr.io/browserless/chromium` + TOKEN var, PRIVATE only; (2) service from this repo root-dir `mcp-browser` + MCP_API_KEY/BROWSERLESS_URL(internal)/BROWSERLESS_TOKEN, public domain; (3) Tools panel: name `browser`, Authorization Bearer key. Read-only tools → safe for `auto` policy.
- Strategy: built-in flat-cost browsing for all workspaces; Firecrawl/Browserbase/Hyperbrowser MCPs = per-workspace premium add-ons (datacenter-IP blocking is the limit of self-hosting).

## Phase 5 — production polish + security hardening (built 2026-07-12 night)
- **Demo removed**: DemoBadge/DemoBanner deleted, all boilerplate marketing templates (Hero/CTA/FAQ/Features/Footer/Navbar/Pricing/Sponsors) deleted, Artivio metadata in `[locale]/layout.tsx`. Only `templates/Logo.tsx` remains (used by DashboardHeader).
- **Landing page**: `[locale]/(marketing)/page.tsx` rewritten — self-contained Artivio marketing page (hero, 6 features, 3-step how-it-works, waitlist section, footer). Waitlist CTA = mailto hello@artivio.ai with prefilled subject/body. No Stripe/checkout yet by design.
- **Help**: `/dashboard/help` — 4 sections (getting started, tools/MCP, approvals & safety, dashboard & missions) + support email. "Help" added to dashboard nav.
- **SECURITY (2026 standard)**: untrusted-content framing. Tool results are wrapped in `<tool_output trust="untrusted">` + the system prompt forbids following instructions found in tool output (prompt-injection defense at the data boundary — the #1 risk in 2026 MCP guidance). See `docs/COMPETITIVE_REVIEW_2026.md`.
- **`docs/COMPETITIVE_REVIEW_2026.md`** — market comparison (Braze/Iterable/Klaviyo/Agentforce/Tofu/1ClickReport/AI agencies), standards scorecard vs 2026 MCP+NSA/CSA guidance, gap list. Conclusion: positioning is differentiated (nobody else is a tool-agnostic multi-tenant agent host); every original brief item is addressed.

## ARCHITECTURE DECISIONS (2026-07-13, Ryan + Claude — do not undo)
1. **HTTP Streamable MCP only.** No stdio support, ever. stdio's value (local files/browser) is meaningless server-side, and spawning third-party npm processes next to client credentials is the #1 supply-chain risk in 2026 MCP guidance.
2. **No wrapper services for stdio-only servers** — adds cost + instability. `mcp-sites/` and `mcp-browser/` were DELETED for this reason.
3. **Two ways to add capability:** (a) vendor has a hosted MCP → register it in the registry, zero code; (b) we resell it (tier 1) → thin adapter IN-APP as a platform tool (no separate service), so metering/billing is exact and in-process.
4. Browserless is the one exception that must be its own service (it's a browser binary) — the app calls it directly, no MCP wrapper.
5. Next real MCP gap = **OAuth for remote servers** (not stdio) — that's where the commercial ecosystem is going.

## Phase 6 — cost ledger + guardrails + admin console (built 2026-07-13, pending push+verify)
- Schema (migration `0006_cost-ledger`): `usage_events` (kind llm|plugin, tokens, costUsd = what WE pay, billedUsd = what client pays), `plugin_catalog` (tier1 = our key + priceRules metering; tier2 = BYO key), tenants gain `planName`/`monthlyBudgetUsd`/`dailyCapUsd`/`paused`. **`credentials.tenantId` is now NULLABLE** = platform-level (tier-1) credential shared across workspaces.
- `src/libs/billing/meter.ts` — MODEL_PRICES table (sonnet/haiku/opus per 1M tokens), `meterLlm()` (exact tokens from the provider response — Bedrock returns them in-band, no AWS bill scraping), `meterPlugin()` (price rules: per-call or per-arg e.g. video seconds), `checkSpend()` (kill switch + daily cap). `BILLING_MARKUP` env (default 1.5).
- Tool loop: `checkSpend()` runs BEFORE every iteration (so a long loop can't blow the cap mid-turn) and `meterLlm()` after every model call. Blocked turns emit "[stopped] …".
- APIs: `/api/admin/overview` (GET all workspaces w/ cost/billed/margin/today-vs-cap; PATCH plan, caps, pause), `/api/admin/users` (GET all + memberships; PATCH isAdmin/disable), `/api/admin/catalog` (CRUD; tier-1 credential sealed into vault), `/api/usage?tenant=` (client's own spend view).
- UI: `/dashboard/admin` (platform admin only, nav link auto-shown) — totals (revenue/cost/margin MTD), workspaces table w/ editable daily cap + Pause-agent switch, users tab, plugin catalog tab w/ Tier 1 price-rules JSON.

### RYAN — Phase 6 notes
- Optional env: `BILLING_MARKUP` (default 1.5 = 50% markup on raw AI/plugin cost).
- Defaults per new workspace: $50/mo budget, **$10/day hard cap**, not paused. Raise caps in the admin console per client.
- Economics sanity check: Sonnet ≈ $3/M in, $15/M out. Even a heavy workspace lands in the low hundreds/month → a $3k/mo client is high-margin. Real cost risks = media generation + runaway loops, both now capped.

## Phase 7 — auth hardening + user management (built 2026-07-13, migration 0007)
- **Logout fix**: NEVER build absolute URLs from `request.url` behind Railway's proxy — it resolves to localhost:8080 and the browser follows it. `/api/auth/logout` now returns a 303 with a RELATIVE `Location: /sign-in`.
- **INVITE-ONLY**: `/api/auth/signup` refuses unless (a) zero users exist (bootstrap → first user = platform admin) or (b) `ALLOW_PUBLIC_SIGNUP=true`. `GET /api/auth/signup` tells the page which state it's in; the sign-up page shows a waitlist CTA (mailto hello@artivio.ai) when closed.
- **Email** (`src/libs/email.ts`, fetch-only): Postmark via `POSTMARK_SERVER_TOKEN`; `EMAIL_FROM` (default hello@artivio.ai), links built from `PRODUCTION_URL`. Sends invite emails (temp password) + password-reset links. Never throws — email failure can't break account creation.
- **2FA (TOTP)** — `src/libs/auth/totp.ts`, pure node:crypto (NO new deps): base32 secret, HMAC-SHA1, 6 digits/30s, ±1 step drift. `/api/auth/2fa` GET status · POST start enrolment (returns secret + otpauth URI) · PUT confirm code → enables + returns 8 backup codes ONCE (bcrypt-hashed at rest) · DELETE (password required). Login accepts `code`; if 2FA on and no code → 401 `{twoFactorRequired:true}` and the sign-in form reveals the code field. Backup codes are single-use.
- **Password**: `/api/auth/password` PUT (change own) · POST (request reset — always 200, never reveals if an account exists) · PATCH (complete with emailed token; sha256-hashed, single-use, 1h expiry). `/reset-password?token=` page. `users.mustChangePassword` set for invited accounts.
- **Admin user CRUD** (`/api/admin/users` + `UsersTab.tsx`): create user (optionally into a workspace with a role) → emails the invite, returns the temp password if email isn't configured; grant/revoke platform admin; reset password; disable/restore; hard delete; add/remove/modify workspace memberships inline.
- New nav: **Account** (`/dashboard/settings` — 2FA + password) for everyone; **Admin** for platform admins.

## Phase 8 — brand + UI revamp (built 2026-07-13, migration 0008)
- **Logo**: `src/components/BrandLogo.tsx` — `<BrandMark>` (gradient tile + ascending bars + spark) and `<BrandLogo>` (mark + wordmark). Pure SVG, no assets.
- **Split-screen auth**: `(auth)/(center)/layout.tsx` — brand panel (generated gradient-mesh + grid art, value props) on the left, form right; mark-only on mobile. Applies to sign-in / sign-up / reset-password / request-invite.
- **Request-invite form** (`/request-invite`, replaces the mailto): name/email/company/website/how-many-clients/use-case → `invite_requests` table (migration 0008) + Postmark notice to hello@artivio.ai. Landing page + sign-in link to it.
- **EMAIL DEBUGGING**: `sendEmail()` now returns the provider's real error and logs it (silent failures were undebuggable). `POST /api/admin/email-test` (admin only) sends a test and returns the Postmark error + hint. **"Test email" button in Admin → Users.** If Postmark rejects: the From address (EMAIL_FROM, default hello@artivio.ai) is most likely not a verified Sender Signature.
- **Dashboard revamp**: left sidebar shell (`features/shell/Sidebar.tsx` — brand, workspace switcher w/ gradient avatars, nav, sign-out; collapses on mobile) replaces the old top nav (DashboardHeader/MobileNavigation/SlashIcon DELETED). Dashboard = header + agent-built panels (rounded-2xl cards) + 2-col: chat (2/3) and side rail (approvals, tools).
- **Chat revamp**: compact bubbles, brand-mark avatar, auto-growing composer (Enter sends, Shift+Enter newline), animated typing dots, `[tool]`/`[approval]` lines rendered as subtle status rows, empty-state with suggestion chips, inline **bold**/`code` rendering.

## Phase 9 — built-in providers (Kie.ai) + plugin marketplace (2026-07-13, migration 0009)
- **Built-in provider framework** (`src/libs/plugins/`): for services we RESELL that have NO hosted MCP (Kie.ai, later HeyGen). In-app adapter = we own the code, meter exactly in-process, no extra Railway service. Vendors WITH a hosted MCP still just get registered as an HTTP connection (zero code).
- `kie.ts` — Kie.ai adapter. Their API is REST + ASYNC (POST /api/v1/jobs/createTask → poll /api/v1/jobs/recordInfo), so the adapter creates the job and polls (3s interval, 4-min ceiling) and hands the agent simple tools: `generate_image`, `generate_video` (metered per `duration_seconds`), `generate_music`, `kie_credits`. Base URL overridable via `KIE_BASE_URL`. NOTE: media is deleted by Kie.ai after 14 days.
- Schema: `plugin_catalog.provider` (builtin slug) + `mcp_connections.catalogId` + transport `builtin`. Registry (`mcp/registry.ts`) resolves builtin connections → adapter + platform credential, and **meters every successful call** via `meterPlugin()` (failed jobs aren't charged).
- **Pricing is now a TABLE, not JSON** (`features/admin/CatalogTab.tsx`): pick a built-in provider → its tools auto-populate rows → enter YOUR cost per call (or per metered arg, e.g. per video-second), set markup % (bulk-apply control), and the client's retail price computes live. Blank cost = unmetered/free. 0% markup = pass through at wholesale.
- **Marketplace**: `GET/POST /api/plugins` + the Tools panel now shows "Available plugins" — Tier 1 enables with one click (uses the platform key; client never sees it), Tier 2 prompts the client for their own key. Clients see RETAIL prices only, never our cost.

### RYAN — adding Kie.ai
Admin → Plugin catalog → Add plugin → "Built-in provider" → Kie.ai → Tier 1 → paste a `KIE_API_KEY_*` value → fill the cost column from kie.ai/pricing → set markup → Save. It then appears in every workspace's Tools panel.

### NEXT GAPS (ranked, from the review)
1. **Spend guardrails** — per-workspace daily $ cap + kill switch before any spending tool. Blocker for autonomous ads.
2. Support inbox via email MCP (use case #9).
3. Client password reset / invite links (currently one-time passwords only).
4. Streaming polish (Bedrock invoke-with-response-stream).
5. Cost ledger (tokens + provider spend per workspace).
6. Register official Google/Meta/TikTok Ads MCPs (they shipped in 2026) → unlocks goal missions with paid channels.

## SAVED FOR LATER (Ryan's asks, do in coming phases)
1. WordPress sites (WellnessTrove?): connect the existing WordPress MCP per site instead of mcp-sites.
2. Worker service (stdio MCP servers, heavy long-running jobs) — scheduled tasks no longer blocked on this.
3. Password change/reset flow for client accounts (currently one-time generated password only).
4. Approval → notify agent/conversation on execution (currently result lives in the inbox).
5. Strip boilerplate marketing landing page + real Artivio branding; retire legacy artivio.ai Railway service.
6. Streaming polish: token streaming when ANTHROPIC_API_KEY present; Bedrock invoke-with-response-stream parsing.

## Phase 10 — futuristic dark UI (2026-07-13)
- `src/styles/global.css`: `.artivio` scope retheming the shadcn tokens dark (deep navy #070b18, indigo/fuchsia accents) — applied ONLY on the dashboard shell, so marketing + auth stay light. Utilities: `.artivio-canvas` (aurora blooms + masked grid), `.glass` / `.glass-hover` / `.glass-topline` (glassmorphic cards w/ gradient hairline), `.grad-text`, `.grad-fill`, `.glow-ring`, `.nav-active`, `.pulse-dot`.
- Sidebar: glass rail, gradient workspace avatars, live pulse on the active workspace, glass user card w/ sign-out icon.
- Panels: glass cards; timeseries now has gradient stroke + area fill + SVG glow filter + delta % badge; KPI uses gradient numerals.
- Chat: glass surface, gradient user bubbles + send button, online/thinking status chips, tool activity as glowing status chips.
- Admin: glass stat cards w/ gradient numerals, glass tables, gradient tab pills.

## Phase 11 — catalog editing + WordPress/Duda presets (2026-07-13, NO migration)
- **Catalog entries are now EDITABLE** (Ryan's ask: he mis-configured Kie.ai and could only Remove). `PATCH /api/admin/catalog` takes the full entry (name, description, category, tier, transport, provider, url, authHeader, authHint, enabled, priceRules, credentialValue rotation). **Slug is immutable** — workspace connections point at it. Blank key on an edit = keep the stored key; setting a key on an entry that never had one creates the platform credential (so tier2 → tier1 promotion works). CatalogTab gets **Edit** + **Hide/Show** buttons and the form doubles as the editor (pricing rows pre-fill from the stored priceRules).
- **`CATALOG_PRESETS`** (`src/libs/plugins/index.ts`, surfaced as "Quick add" chips in Admin → Plugin catalog): **Duda**, **WordPress**, **GitHub**. Pure form pre-fills — nothing hardcoded in the platform.
- **Duda = hosted MCP, zero code.** URL `https://mcp.duda.co/mcp`, header `Authorization` = the Access Token from the Duda dashboard → Account Settings → MCP (no `Bearer` prefix, per their docs). Register as Tier 2 (client's own Duda account) or Tier 1 if it's on Ryan's account.
- **WordPress = built-in PER-CONNECTION provider** (`src/libs/plugins/wordpress.ts`). There is no official WP MCP and nothing to install on the client's site: WP already exposes the REST API and ships **Application Passwords** (WP Admin → Users → Profile → Application Passwords) — a revocable credential for exactly this. Credential format the client pastes: `username:xxxx xxxx xxxx xxxx` (HTTP Basic). Tools: list_posts, get_post, create_post (**defaults to DRAFT**), update_post, list_pages, update_page, list_categories.
- **Per-connection built-ins** (`BuiltinProvider.perConnection`): unlike Kie.ai (one platform key for everyone), each workspace supplies its OWN target + credential. `mcp_connections.url` = the site URL, `headerCredentials` = the workspace's sealed credential; the registry passes both to `provider.call(tool, args, credential, target)`. `/api/plugins` returns `needsSiteUrl` so the Tools panel asks for the site URL alongside the key. This is the pattern for any future "each client has their own account" adapter.

## Phase 12 — Kie multi-key + usage metering + FILE LIBRARY (2026-07-13, migration 0010)
### Kie.ai (Ryan's issues 1 & 2)
- **Multi-key round-robin (up to 20).** `credentials.cipher` for a multi-key provider holds MANY keys, one per line. `kie.ts` `parseKeys()` + `withKey()` rotate a module-level cursor and **fail over** on 401/402/403/429/433/455 (blocked / no credit / rate-limited); real errors (bad prompt, failed gen) do NOT burn keys. Kie's 20-req/10s limit is PER ACCOUNT → more keys = more throughput + no single point of failure. `BuiltinProvider.multiKey`. Admin catalog: textarea (one key per line), GET returns `keyCount` only (never values), badge "N keys in rotation". `kie_credits` now reports every key's balance.
- **DO NOT scrape kie.ai/pricing (368 rows, changes weekly).** `recordInfo` returns **`creditsConsumed`** per task and Kie credits are a **flat $0.005** across every model (840cr=$4.20, 14cr=$0.07, 480cr=$2.40 — all ×0.005 ✓). So: `BuiltinProvider.usageMetering` + `PriceRule { unit: 'usage', costUsd: 0.005, markup }` → `BuiltinResult.units` flows out of `provider.call` → registry passes `reportedUnits` to `meterPlugin()` → **exact billing for all 368+ models, image and video and music, forever, with one number.** Failed jobs report nothing → client is never charged. Admin UI shows a single "your cost per credit / markup % / client pays" card instead of a price table.
- `BuiltinProvider.call` may now return `string | BuiltinResult { output, units?, assetUrls? }`.

### File library (Ryan's issues 3 & 4) — `files` table, R2
- **Why**: (a) a client's 5-page WordPress change-list shouldn't be a chat prompt — upload it, the agent reads it; (b) **Kie.ai deletes generated media after 14 days**, so a published image/video URL would die.
- `src/libs/storage/r2.ts` — S3-compatible R2 client, **AWS SigV4 signed by hand with node:crypto (NO new deps)**. Vars (same bucket as BudgetSmart, already in Railway): `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (or `R2_TOKEN_VALUE`), optional `R2_PUBLIC_URL`.
- `src/libs/storage/files.ts` — `saveFile` (extracts text for txt/md/csv/json/html so `read_file` is a single DB read), `archiveGeneratedAssets` (pulls provider URLs into R2), `listFiles`/`getFile`/`removeFile`. **Keys are always `tenants/<tenantId>/…`, derived from the session — never from client input.**
- Registry: after any builtin call, `result.assetUrls` are archived and the agent is told to use the **library URL, not the provider URL**.
- Agent platform tools (auto): **`list_files`, `read_file`, `save_note`**. Prompt now tells the agent to check the library BEFORE substantial work, and that an uploaded brief is a REQUEST to plan from — not pre-approval for side effects.
- API `/api/files` (GET list · POST multipart upload, 25MB, editor+ · DELETE) and `/api/files/[id]/content` (membership-checked stream, for private docs / no public bucket domain).
- UI: **/dashboard/files** (`features/files/FileLibrary.tsx`) + "Files" in the sidebar. Tabs: All · Documents · Generated media; image thumbnails; "agent-readable" badge.
- Zernio (when connected): it can post the archived R2 URLs — that's exactly why assets are archived with stable links.
- **Public vs private split (2026-07-13):** the R2 custom domain is **s.artivio.ai** (`R2_PUBLIC_URL`). A custom domain serves objects to anyone with the URL, so `publicUrl` is set ONLY for `kind='asset'` (generated media must be publicly fetchable by WordPress/social/Zernio). Client documents (`knowledge`/`note`) get `publicUrl = null` and are served through `/api/files/<id>/content`, which re-checks workspace membership. Do not "fix" this by making everything public.
- **R2_ENDPOINT gotcha (hit 2026-07-13):** Cloudflare's bucket page shows `S3 API: https://<account>.r2.cloudflarestorage.com/<bucket>` — endpoint WITH the bucket. We build path-style URLs (`endpoint/bucket/key`), so pasting that verbatim double-prefixed every key (`artivio/tenants/…`) → upload "succeeded" but `s.artivio.ai/tenants/…` 404'd. `r2Config()` now reduces R2_ENDPOINT to its ORIGIN, so either form works. Bucket in use = **`artivio`** (new, ENAM, created 2026-07-13), custom domain **s.artivio.ai** (Active, public access Enabled).
- **Direct-to-R2 uploads (2026-07-13, Ryan: "25MB is far too small — we do a lot of video")**: browser uploads now bypass the app entirely. `POST /api/files/upload?tenant=` → `reserveUpload()` mints a tenant-scoped key + **presigned PUT URL** (`presignPutUrl()` in r2.ts: query-string SigV4, UNSIGNED-PAYLOAD, signs only `host` so the browser may send Content-Type freely, 15-min expiry) → the browser XHR-PUTs straight to Cloudflare (progress bar) → `PUT /api/files/upload?tenant=` → `confirmUpload()` HEADs the object (proves it landed, gives the REAL size) and indexes it. **Limit is now 5GB** (R2's single-PUT ceiling; >5GB needs multipart). The key is minted server-side inside `tenants/<tenantId>/` and re-checked on confirm — a client can't sign into another workspace's prefix. The old multipart `POST /api/files` (25MB, through the app) remains as a fallback but the UI no longer uses it.
- **R2 CORS must now allow PUT** for the presigned uploads (from the app origin only). Current policy: AllowedOrigins `https://artivio.ai` + `http://localhost:3000`; AllowedMethods **GET, HEAD, PUT**; AllowedHeaders `content-type`; ExposeHeaders `ETag`.

## Phase 12b — fixes from Ryan's testing (2026-07-13, no migration)
- **Workspace delete**: `DELETE /api/tenants?slug=…&confirm=<slug>` (platform admin; slug must be echoed). Purges the workspace's R2 objects FIRST (no FK cascade reaches the bucket), then deletes the tenant — every child table cascades. "Danger zone" button in `WorkspacePanel`.
- **Upload 403 for editors**: `/api/files` POST read the tenant slug from the multipart BODY, so a body that failed to parse (e.g. an oversized file) fell through to "you need editor access". Tenant now comes from the QUERY STRING and the role check runs BEFORE the body is read; body-parse and size failures have their own messages (and the client checks 25MB before sending).

## Phase 13 — web reading (2026-07-13, no migration, no new deps)
- **The honest gap was**: the agent could not read a web page at all (`mcp-browser/` had been deleted under the no-wrapper-services rule and never replaced).
- `src/libs/agent/webTools.ts` → **`fetch_url`** only, merged into `buildPlatformTools()` (policy `auto`, read-only). Plain fetch + HTML→text, free, no JS. Covers blogs/docs/APIs/competitor copy and verifying our own server-rendered sites. Tells the model when a page looks client-rendered instead of letting it hallucinate content.
- **SSRF guard** (`assertPublicUrl`): http(s) only; blocks localhost, `.internal`/`.local` (Railway private network!), 10./127./0./169.254./192.168./172.16-31. The agent picks these URLs — sometimes from untrusted page content — while sitting next to Postgres on the private network.
- **BROWSERLESS IS DEAD (Ryan's call, 2026-07-13).** ARCHITECTURE DECISION #4 is REVERSED: no self-hosted browser service, ever. Reasons: it costs money + memory, and its datacenter IP is blocked by exactly the sites that need a real browser — so it solved nothing fetch couldn't do. **Supersedes the "Browserless is the one exception" note in the ARCHITECTURE DECISIONS section.**
- **Replacement strategy (researched, NOT yet installed — Ryan is evaluating)**: when `fetch_url` can't read a page, register a hosted MCP in the Tools panel — zero code, cost lands on the workspace that needs it:
  - **Firecrawl** — page → clean markdown/JSON, credit-per-page (~$19–399/mo). The likely platform default (Tier 1, our key + markup).
  - **Bright Data MCP** — 400M+ residential IPs for sites that actively block scrapers. Tier 2 (client's key) — e.g. BargainBalloons competitor price monitoring.
  - Cloud browsers (Browserbase/Hyperbrowser/Steel) are only for AUTHENTICATED multi-step flows. We don't need them: Zernio/WordPress/GitHub/Duda/ads all have APIs or MCPs.
- **Still missing: WEB SEARCH.** The agent can read a URL but cannot find one. Bigger day-one gap than JS rendering; fix with a search MCP (Brave/Exa/Firecrawl search).

## Phase 12c — approvals ran only HTTP MCP, never built-ins (2026-07-14, no migration)
- **Ryan's Kie.ai bug**: approving `mcp__kie-ai__generate_image` failed with "The tool connection is no longer available." Cause: `/api/approvals/[id]` was written in Phase 2 and re-implemented HTTP MCP calling inline, gated on `conn.transport === 'http'` — so EVERY built-in provider (Kie, WordPress) threw that misleading error on approval, and approved calls ALSO skipped metering + asset archiving (all of which live in the registry executor).
- **Fix**: the route now runs the approved call through `buildTenantToolset(tenantId).resolve(toolName).call(args)` — the exact same executor the agent uses for auto calls. One code path → approved calls meter, archive Kie assets, and support every transport. `maxDuration = 300` (Kie video is slow). Error text is now accurate ("… not available … connections reporting problems: …").
- **Agent behaviour**: it had confidently told Ryan to "reconnect Kie in the Tools panel" — a hallucinated fix, because it faithfully relayed the misleading hard-coded error. Prompt now instructs: on tool failure, relay the real error verbatim, admit it can't see platform code/logs, and NOT invent remediation steps the error doesn't state. The agent cannot self-repair the platform (no source/deploy access — and shouldn't have it).

## Phase 14 — issue triage + escalation (2026-07-14, migration 0011)
- **Problem it solves** (from the Kie incident): the platform threw a misleading error → the agent invented a plausible fix ("reconnect it in the Tools panel") → Ryan burned time on a dead end. Making the agent "smarter" is the wrong fix; making the platform TELL THE TRUTH and route the failure to whoever can act on it is the right one.
- `src/libs/support/issues.ts`:
  - **`classifyToolError()`** — who can actually fix this? `config` (client: bad key 401/403, bad URL 404/DNS, missing credential) · `provider` (429/402/5xx/timeout — their problem, retry) · `platform` (**anything we don't positively recognise** — conservative on purpose: silently blaming the client for our defect is the costliest failure).
  - **`captureIssue()`** — writes an `issues` row with the REAL error + redacted args + stack, and **emails the operator ONLY for `platform` class** (config/provider noise would train Ryan to ignore the inbox). Never throws.
  - **`buildBundle()`** — copy-pasteable markdown diagnostic (where/workspace/when/verbatim error/context JSON) so a bug is actionable without interviewing the client.
- **Wired in**: `loop.ts` tool-failure path (agent is now handed the classification + an explicit "do NOT invent troubleshooting steps"), `/api/approvals/[id]` failure path (returns `kind`/`guidance`/`escalated`), and `report_issue` platform tool (policy `auto`) so the agent can escalate things no exception caught.
- **Prevention beats triage**: `POST /api/mcp/test` + **"Test connection" button** in the Tools panel probes a hosted MCP server (initialize + tools/list) BEFORE saving and reports the real, classified error next to the field that caused it. Most "the tool is broken" reports are a wrong URL or bad key.
- **Operator surface**: `/api/admin/issues` + **Admin → Issues** tab (`IssuesTab.tsx`) — red badge counts open `platform` bugs, colour-coded by who owns the fix, "Copy bundle" hands it straight to an engineer, Resolve closes it.
- Schema: `issues` (tenantId nullable, kind, source, message, detail jsonb, status, reportedByAgent). Migration `0011_issues` — hand-written, idempotent.

## Phase 15 — prompt caching, web search, deploy guard (2026-07-14, no migration)
- **PROMPT CACHING (biggest margin lever).** Measured on the live ledger: 76,887 input tokens vs 2,209 output — a **35:1 ratio**. Cost is almost entirely the system prompt + tool definitions being re-sent on every turn AND every tool-loop iteration. `cachedSystem()` in `anthropic.ts` puts one `cache_control: ephemeral` breakpoint on the system block; because the request prefix is ordered **tools → system → messages**, that single breakpoint caches BOTH the tools and the system prompt. Applied to the Bedrock and Anthropic paths. Below the model's minimum cacheable length the breakpoint is ignored (no error), so it's safe for small prompts.
- **Cache metering is honest**: reads bill at ~10% of input (already priced), **writes bill at 1.25x** — `meter.ts` now prices `cacheWriteTokens` via `CACHE_WRITE_MULTIPLIER`, and `loop.ts` passes `cache_creation_input_tokens`. Without this the ledger would under-report our real cost on the first call of every session.
- **Firecrawl = web search + scrape (Tier 1 preset).** Closes the "agent can read a URL but can't FIND one" gap in one integration.
  - **SECURITY — key-in-URL**: Firecrawl's hosted MCP is `https://mcp.firecrawl.dev/{key}/v2/mcp` — the API key is a PATH SEGMENT, and `mcp_connections.url` is plaintext. So the catalog stores a URL **template** and the secret lives in the vault under the reserved credential name **`url`**; `applyUrlSecret()` (registry) substitutes `{key}` at call time, in memory, and strips it from the headers so it's never also sent as one. Reusable for any vendor that puts keys in paths.
  - **Tier-1 HTTP plugins were broken**: the registry reads credentials from the CONNECTION, but a tier-1 platform key lives on the CATALOG entry — so a tier-1 HTTP plugin connected with no key at all. `/api/plugins` POST now points the connection's `headerCredentials` at the catalog's platform `credentialId` (row has `tenantId NULL`; the client gets the capability, never the value).
- **deploy.bat now TYPECHECKS before pushing** (`npm run check:types`) and **fails loudly on every step**. Root cause of two wasted Railway builds: the sandbox reads mounted files corrupted, so Railway was the first thing to ever compile the code. Also fixes the silent-commit-failure that made a corrupt `.git` look like a successful deploy for 12 hours.
- **Non-bug (verified, don't "fix" it)**: daily caps ARE set — `/api/admin/overview` reports `dailyCapUsd: 10` on every workspace. The `$0.00` visible in a scraped page dump is an input field whose value doesn't appear in text extraction.

## Phase 16 — AgentCore Browser adapter (2026-07-14, no migration)
- **What it is**: a real Chrome running in AWS, driven over CDP. Reads JS-rendered pages `fetch_url` can't see, and can operate web apps with no API — **unattended**, which a browser on Ryan's laptop cannot do. Sessions are recorded to S3 (audit trail).
- **API shape** (verified against AWS docs, not guessed): data plane `https://bedrock-agentcore.{region}.amazonaws.com`; `PUT /browsers/{browserId}/sessions/start` → `{sessionId, streams.automationStream.streamEndpoint (wss://), streams.liveViewStream}`; `PUT /browsers/{id}/sessions/stop?sessionId=`. SigV4 service name = **`bedrock-agentcore`**.
- **`src/libs/aws/sigv4.ts`** — generic SigV4 header signer (node:crypto). Needed because the WS upgrade must carry **SigV4 headers** (AWS's SDK calls this `generate_ws_headers`).
- **FIRST REAL DEPENDENCY: `ws`.** Node's native WebSocket (undici) CANNOT send custom headers, and AgentCore requires them — so `ws` is not optional. Added `serverExternalPackages: ['ws']` in next.config so the bundler leaves it alone. (Playwright was rejected: it would drag a browser driver into the server bundle for a browser that lives in AWS.)
- **`src/libs/browser/agentcore.ts`** — session start/stop + a hand-rolled minimal CDP client (Target.getTargets → Target.attachToTarget flatten → Page.navigate → Runtime.evaluate). Sessions are **always stopped in a `finally`** — an orphaned session bills until its timeout.
- **`src/libs/plugins/agentcoreBrowser.ts`** — built-in provider (tools: `browse_page`, `scrape_page`), so it inherits approvals + metering + spend caps like any plugin. **Usage-metered per session-second** (`BROWSER_USD_PER_SECOND` ≈ $0.11/hr ÷ 3600) — the adapter reports how long the session was actually alive, so a 4-second page read costs a fraction of a cent.
- **`BuiltinProvider.noCredential`** — new flag: this provider needs NO key (it rides the platform AWS creds already used by Bedrock). Threaded through registry, `/api/admin/catalog`, `/api/plugins` and CatalogTab so tier-1 no longer demands a credential.
- **Env**: `AGENTCORE_BROWSER_ID` = the custom browser (`ArtivioBrowser-SfMKCTqEuf`, has recording + Web Bot Auth). Falls back to AWS's system browser `aws.browser.v1` if unset.
- **v1 is STATELESS on purpose** (start → navigate → read → stop, one call). Persistent sessions + **browser profiles** (log into Duda once via live view, reuse the cookies unattended) are the next slice — the profile resource exists (`browser_profile_yy0u2`) but `start_browser_session` profile wiring is NOT built yet. Don't claim it works until it's tested.
- **UNTESTED**: written from the docs; I have no way to run AWS calls from the sandbox. First real call is the test. Failures will now surface honestly via the Phase 14 triage rather than as a hallucinated fix.

## Phase 17 — the agent could not save binary files (2026-07-14, no migration)
- **Ryan's QR-code bug**: asked for a QR PNG, the agent generated one via a QR API, then saved a **markdown note containing the link** and called it done. When pushed it correctly admitted `save_note` is text-only — but then recommended connecting **Cloudinary / Google Drive / an S3 MCP**, which is FALSE: R2 storage is built in and the registry already archives Kie's media. It even offered to generate a QR code with Kie (an AI image model cannot produce a scannable QR).
- **Root cause**: there was no tool to put BYTES in the library. `save_note` (text) and the Kie auto-archive path existed; nothing let the agent save an arbitrary file it found or produced.
- **Fix**: `saveRemoteFile()` in `storage/files.ts` + platform tool **`save_file_from_url`** (policy `auto`, SSRF-guarded via the exported `assertPublicUrl`, 100MB cap, HEAD size pre-check). Saves as `kind='asset'` so it gets a public R2 URL and appears under Generated media — publishable to WordPress/social.
- **Prompt hardened**: "save_note stores TEXT only… storage is BUILT IN… never tell the user you cannot save images or that they need a storage/Drive/Cloudinary MCP — that is false, and saving a link inside a markdown note is NOT saving the file."
- **Lesson (recurring)**: the agent's failure mode is inventing an integration to buy rather than admitting a capability gap. The fix is always (a) give it the real tool and (b) tell it plainly what the platform already does.

## Phase 18 — full pre-emptive audit (2026-07-14, no migration)
- Ran the `docs/QA_CHECKLIST.md` eight failure classes against the whole codebase (two parallel sub-agent audits + manual). **No cross-tenant leak, no admin-gate hole, path parity solid.** Fixed 7 real bugs found:
  - **HIGH — secret leak to audit_log**: `loop.ts` wrote raw tool `args` into `audit_log.detail` (a designated never-secret column) on all four `audit()` calls, while the failure path redacted the SAME args into `issues`. Now all four use `redact(args)`.
  - **MED — shallow redaction**: `issues.ts` `redact()` only checked top-level keys, so `{headers:{Authorization:…}}` leaked into `issues.detail` + the escalation email. Rewrote it to RECURSE (depth-capped), exported it, and it now redacts the WHOLE `detail` object, not just `.args`. `captureIssue` gained `forceKind` so benign flags don't email.
  - **MED — Kie money leak**: a job outrunning the poll window returned success with no `units` → billed **$0 while Kie keeps burning credits** (video, the priciest op, is exactly what overruns). Poll window raised to 285s (just under the 300s route budget) so nearly all jobs bill in-band; genuine overflows now set `BuiltinResult.pendingReconcile` → the registry logs a provider-class Issue (visible, not emailed) instead of silent $0. Metering now requires `units !== undefined`.
  - **MED — approve bypasses spend cap**: `/api/approvals/[id]` executed approved calls WITHOUT `checkSpend`, so a paused/over-cap workspace could still run a queued Kie video by clicking Approve. Now 402s if blocked.
  - **LOW-MED — tier-1 HTTP unmetered**: the registry's HTTP branch never loaded `priceRules`, so a resold HTTP MCP on our key would run free. It now loads the catalog entry's rules and meters on success exactly like built-ins.
  - **LOW — `credentials.label` overflow**: `${name} · ${header}` could exceed `varchar(120)` and 500 the insert (Postgres errors, not truncates). `.slice(0,120)` on both builders.
  - **LOW — unmetered streaming footgun**: dead `streamClaude` makes real model calls with no metering; marked with a loud ⚠️ so it can't be wired into a route without `meterLlm`.
- **Verified correct (do not re-flag)**: all `/api/admin/*` gated on `isAdmin`; every tenant-scoped read derives tenant from the session (never client body); id-addressed routes re-scope by `AND tenantId`; storage keys server-derived + re-checked on confirm; workspace-delete purges R2; admin catalog GET returns `hasCredential`/`keyCount` only; Firecrawl url-secret pattern; all enum contracts (unit/role/tier/transport/decision/toolPolicy/panel-type) aligned across UI↔zod↔DB; browser sessions stopped in `finally`; cache read+write both metered on both providers; no double-billing.
- **Deferred (low value)**: separate `cacheWriteTokens` column for audit (cost is already correct, only the count isn't independently stored); full Kie reconciliation table + cron (pendingReconcile flag is the interim).

## Phase 19 — WhatsApp messaging + consent (2026-07-14, migration 0012)
- **Ryan was on Twilio's RCS onboarding by mistake — RCS ≠ WhatsApp.** RCS (Google carrier messaging) requires a LIVE opt-in flow that carriers test before approving; WhatsApp does NOT gate activation on opt-in (it enforces during operation). Decision: **WhatsApp only.** The RCS form is abandoned. The consent flow is still built because WhatsApp policy requires opt-in + honored opt-out.
- **`src/libs/messaging/whatsapp.ts`** — the one Twilio path. Auth supports BOTH API Key (`TWILIO_API_KEY_SID` SK… + `TWILIO_API_KEY_SECRET`) and classic (`TWILIO_AUTH_TOKEN`); either way `TWILIO_ACCOUNT_SID` (AC…) is required (it's in the message URL). Ryan pasted an API KEY (SK…), so he still needs the Account SID (AC…). `TWILIO_WHATSAPP_FROM` = `whatsapp:+…`.
- **Golden rule**: `sendWhatsAppToContact(phone, body)` sends NOTHING without an active `messaging_consents` row (opted_out_at IS NULL). Returns `{sent, reason}` so the agent gets an honest reason, never a silent no-op. Operator alerts (`sendOperatorWhatsApp` → Ryan's own `OPERATOR_WHATSAPP_TO`) are the one exception — his own number, his consent.
- **`notify.ts` refactored** to call the shared sender (one Twilio auth path, no duplicated fetch).
- **Consent surfaces**: public opt-in page `/whatsapp` (`OptInForm` — phone + un-prechecked consent box quoting the exact consent text + STOP/HELP + links to /terms & /privacy) → `POST /api/messaging/optin` records consent and fires a double-opt-in "reply YES" confirmation. **Twilio inbound webhook** `POST /api/messaging/webhook` (TwiML replies) handles STOP/UNSUBSCRIBE/CANCEL → `optOut`, START/YES → `reactivateConsent`, HELP → info. This makes the opt-out promise in both legal pages REAL.
- **Migration 0012** = `messaging_consents` (tenantId/userId nullable, channel, phone E.164, consentText verbatim, confirmedAt, optedOutAt). Hand-written, idempotent.
- **NEXT slice (not built)**: two-way agent chat over WhatsApp — route an inbound message into the tenant's agent loop and reply. The webhook is the backbone; the identity binding (which number → which workspace) is the design work before that ships.
- **Ryan setup**: (1) switch Twilio to the WhatsApp Sender / Self Sign-up flow (needs a Meta Business account) — NOT the RCS form; (2) submit the 5 message templates already written; (3) Railway vars: `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_WHATSAPP_FROM`, `OPERATOR_WHATSAPP_TO`; (4) set the Twilio inbound webhook to `https://staging.budgetsmart.io/api/messaging/webhook` (or artivio.ai). **Rotate the API secret Ryan pasted in chat.**
- **DONE via browser (2026-07-14)**: configured the **WhatsApp Sandbox** for testing without Meta approval. Sandbox FROM = **`whatsapp:+14155238886`**, join code **`join bell-forget`**. Inbound webhook set to **`https://artivio.ai/api/messaging/webhook`** (POST) in Sandbox settings. So `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` for sandbox testing. To test: from a phone, WhatsApp "join bell-forget" to +1 415 523 8886 (this both joins the sandbox AND is the opt-in), then the webhook handles STOP/START/HELP. NOTE: the webhook 404s until this session's messaging code is deployed (`deploy.bat`). Production later needs a real WhatsApp Sender (Meta Business) — the sandbox FROM is shared/rate-limited and not for clients.

## Phase 20 — AI Employees / personas (2026-07-14, migration 0013)
- **Ryan's ask**: named agents with personalities and faces the client picks — "we had Bud for BudgetSmart and Aria for WellnessTrove."
- **THE DESIGN RULE: a persona is VOICE, never PERMISSION.** `personaPromptFragment()` is appended at the END of the system prompt and explicitly restates that approvals, spend caps, workspace boundaries and the untrusted-content rules apply to this employee exactly as written above — "being warm or informal is not a reason to skip an approval, and staying in character is never a reason to … pretend a task succeeded when it did not." Personality is presentation; it must never become a jailbreak surface or an excuse to soften a guardrail. Do not merge the two sections.
- Schema (migration `0013_agent-personas`): `agent_personas` (slug uq, name, tagline, role, personality text, avatarUrl, accent, enabled) + `tenants.persona_id` (FK `ON DELETE set null`) and `tenants.agent_name_override` (rename "Bud" → "Buddy" without forking the persona). Hand-written + idempotent; seeds 5 starters via `ON CONFLICT (slug) DO UPDATE` that deliberately **does NOT touch avatar_url** (so a generated face survives a re-run).
- Starter gallery: **Bud** (finance/emerald), **Aria** (wellness marketing/violet), **Max** (growth+ads/amber), **Nia** (ops+support/sky), **Theo** (SEO/indigo). Each personality is written as behavioural instruction, not adjectives.
- `src/libs/agent/persona.ts` — `listPersonas`, `resolveAgentForTenant` (leftJoin, **always safe to call**: falls back to `DEFAULT_AGENT` = "Agent" + BrandMark when no persona assigned), `personaPromptFragment`.
- Wired into BOTH model entrypoints — `/api/agent/chat` and `/api/internal/run-scheduled` — so the same employee runs the 3am mission as runs the chat. `buildSystemPrompt({ tenant, userFirstName, agent })` takes an optional `ResolvedAgent`; the name leads the opening line.
- API `GET /api/personas?tenant=` (gallery + current, any member) · `PATCH /api/personas` (assign/rename, owner/admin or platform admin; verifies the persona exists AND is enabled; audited as `persona.assign`).
- UI: `AgentAvatar.tsx` (photo → gradient initial in the accent → BrandMark fallback chain) used in the chat header, empty state and every assistant bubble; `EmployeePanel.tsx` in the dashboard side rail (managers only) — pick, rename, or drop back to the generic agent; dashboard header greets with the employee's name.
- **Faces are NOT generated yet** — `avatar_url` is null on all 5 seeds, so they render as gradient initials. Generating them via Kie is a one-off admin job (`generate_image` → `save_file_from_url` → paste the R2 URL); the fallback chain means nothing is broken until then. Don't claim they have photos.
- **WhatsApp templates do NOT carry the persona name yet** — two-way agent chat over WhatsApp isn't built (the identity binding is still the open design work), so there's no per-client message path to name. Wire it when that ships.

## Phase 21 — dashboard layout: tabs, sections, width, drag (2026-07-15, migration 0014)
- **Ryan's report**: "I asked the agent to re-organize the dashboard but it seems pretty limited… it will keep adding panel after panel but unable to make things collapsible, or allow the user to drag panels… after adding several MCPs the dashboard will become extremely messy."
- **Diagnosis — this was a SCHEMA gap, not an agent/prompt gap.** `dashboard_panels` had exactly four meaningful fields (type/title/config/position). There was no vocabulary for a tab, a group, a width or a collapsed state, so "add a panel" was the only verb the agent owned. **The tell**: on Bargain Balloons it had created a markdown panel titled "ANALYTICS" containing `## 📊 Analytics Overview` + a list of what the KPIs/Trends/Tables were, with `&nbsp;|&nbsp;` separators — it was hand-rolling a section header out of the only primitive available. When an agent fakes a feature, the platform is missing a primitive; making the model "smarter" would have changed nothing.
- **Three levels**: views (TABS — the structural fix that bounds mess by domain) → `section` (collapsible group label within a tab) → `width` 1-3 columns per panel.
- Schema (migration `0014_dashboard-layout`): `dashboard_views` (tenant, name, icon, position) + panels gain `view_id` (FK **ON DELETE set null**), `section` varchar(60), `width` int default 1. Hand-written + idempotent.
  - **Backfill matters**: the migration creates an "Overview" view for every tenant that already has panels and files them into it — otherwise live dashboards (Bargain Balloons ~12 panels) render as unfiled on deploy day. It also widens existing `table` panels to 3 and timeseries/markdown to 2, because a 4-column table at 1/3 width was most of the "messy" feeling.
- **Panels can never be orphaned by a lost tab**: FK is `set null`, `delete_view` reports how many panels became unfiled, and `GET /api/panels` re-homes any panel whose `viewId` no longer resolves onto the first tab.
- Agent tools (all policy `auto` — layout touches nothing outside the workspace's own dashboard, spends no money, and is trivially reversible): `list_views`, `create_view`, `update_view`, `delete_view`, `move_panels` (BULK — one call for a whole tidy-up), and `create_panel`/`update_panel`/`list_panels` gained viewId/section/width. `resolveViewId()` accepts an **id or a name** because agents reason in names, not uuids; an unknown name errors with the list of real tabs rather than silently creating a duplicate. `create_view` returns the existing tab instead of duplicating on a name clash.
- **`DEFAULT_WIDTH` by type** (kpi 1 · timeseries 2 · markdown 2 · table 3) so a dashboard is readable WITHOUT anyone tidying afterwards. Prevention beats a cleanup verb.
- `move_panels` reports partial failure honestly (`Moved 4 of 7… Problems: …`) rather than claiming a clean reorganise.
- **Prompt**: the agent is told layout is its job, to call `list_views` before creating panels, to use `move_panels` in one call for reorganises, **never to create a markdown panel as a heading/divider**, and to treat a user's manual drag arrangement as intentional (don't reshuffle a tab you weren't asked to touch).
- UI (`PanelsGrid.tsx`): tab bar (hidden when there's only one view), collapsible section headers, width-aware grid spans via a **static** `SPAN` map (Tailwind can't see template-built class names), HTML5 drag — reorder within a section, drop on a section header, **drop onto a tab to move a panel between tabs**. Optimistic + `PATCH /api/panels`.
  - **`frozen` ref**: the 30s poll is suspended during a drag and until the PATCH resolves — otherwise a poll yanks the card out from under the cursor or repaints the pre-drag order. On PATCH failure we deliberately let the next poll revert to the server's truth rather than keep a lying dashboard.
  - Active tab + collapsed sections are **per-user localStorage** (`artivio:dash:<slug>`), not DB — it's a UI preference, and two people sharing a workspace shouldn't fight over it.
- `PATCH /api/panels` is editor+; **role check runs BEFORE the body is read** (the Phase 12b upload-403 lesson), panel ids are re-scoped with `AND tenantId`, and a `viewId` pointing at another tenant's tab is dropped.

## Gotchas
- **Migration 0010 was hand-written** (SQL + `_journal.json`), because bash reads of the mounted repo are stale/truncated so drizzle-kit can't see the real `Schema.ts`. The SQL is idempotent (`IF NOT EXISTS` + `DO $$ … EXCEPTION WHEN duplicate_object`). If drizzle-kit ever regenerates from the last snapshot it may re-emit `files` — harmless, but delete the dupe.
- **Bash cannot read mounted files reliably** (virtiofs returns NUL-padded or truncated content — `Schema.ts` read as 1KB when it's 15KB). Never typecheck/build/patch from bash on the mount; use Read/Grep/Edit/Write tools.
- **DO NOT patch mounted .tsx files with python/sed via bash.** The virtiofs mount returns stale/NUL-padded reads, so a read-modify-write TRUNCATES the file (this silently corrupted AgentChat.tsx + ToolsPanel.tsx). Use the Edit/Write tools, which are reliable. Bash greps of mounted files can also report false zeros — verify with Grep/Read.
- Railway dashboard SPA: screenshots often hang; use get_page_text / find refs. Settings inputs need the expand button clicked first; changes stage into an "Apply N changes" → Details → Deploy Changes flow (discard stray empty staged changes).
- Git write-ops don't work from the Cowork sandbox on mounted folders — Ryan pushes.
- Never print secrets to chat; secrets live in Railway variables / .env.local only.
