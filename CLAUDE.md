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

## Gotchas
- **DO NOT patch mounted .tsx files with python/sed via bash.** The virtiofs mount returns stale/NUL-padded reads, so a read-modify-write TRUNCATES the file (this silently corrupted AgentChat.tsx + ToolsPanel.tsx). Use the Edit/Write tools, which are reliable. Bash greps of mounted files can also report false zeros — verify with Grep/Read.
- Railway dashboard SPA: screenshots often hang; use get_page_text / find refs. Settings inputs need the expand button clicked first; changes stage into an "Apply N changes" → Details → Deploy Changes flow (discard stray empty staged changes).
- Git write-ops don't work from the Cowork sandbox on mounted folders — Ryan pushes.
- Never print secrets to chat; secrets live in Railway variables / .env.local only.
