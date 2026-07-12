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

## Phase 1 — agent core (built 2026-07-11 late, pending push+verify)
- `src/libs/agent/anthropic.ts` — multi-provider Claude transport via fetch (NO sdk deps), first configured wins: BEDROCK_API_KEY bearer invoke (non-streaming, single-chunk yield; BEDROCK_MODEL_ID default us.anthropic.claude-sonnet-4-6, BEDROCK_REGION/AWS_REGION default us-east-1) → ANTHROPIC_API_KEY streaming (ANTHROPIC_MODEL default claude-sonnet-4-5). Ryan runs Bedrock keys (same as BudgetSmart), no Anthropic key.
- `src/libs/agent/prompt.ts` — tenant-scoped system prompt (Bud pattern; honest about Phase 2 tools not existing yet).
- `src/libs/tenants.ts` — getUserTenants + ensureDefaultTenant (admin's first dashboard visit auto-creates tenant 'artivio' + owner membership).
- API: POST `/api/agent/chat` {tenantSlug, message} → plain-text stream, history loaded server-side, one rolling conversation per tenant+user; GET `/api/agent/history?tenant=slug`.
- Schema: `conversations` + `messages`; migration `0002_agent-conversations` (runs pre-deploy).
- UI: `src/features/agent/AgentChat.tsx` on /dashboard (streams, reloads history on refresh).
- No new npm deps (fetch-based) → no lockfile change needed for this phase.

## Phase 2 — next
- Per-tenant MCP registry (`mcp_connections` + libsodium credential vault) + tool loop in the chat route + approvals gateway + dynamic dashboard panels (see Claude Plan v1).

## Gotchas
- Railway dashboard SPA: screenshots often hang; use get_page_text / find refs. Settings inputs need the expand button clicked first; changes stage into an "Apply N changes" → Details → Deploy Changes flow (discard stray empty staged changes).
- Git write-ops don't work from the Cowork sandbox on mounted folders — Ryan pushes.
- Never print secrets to chat; secrets live in Railway variables / .env.local only.
