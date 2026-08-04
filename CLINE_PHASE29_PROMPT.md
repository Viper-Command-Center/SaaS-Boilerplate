# Phase 29 — Reliability + Token Efficiency batch (prompt for Cline)

You are working in the **SaaS-Boilerplate** repo (Artivio Command Center, Next.js App Router + Drizzle + Railway). Read `CLAUDE.md` first — especially Phases 26–28.2 and the Gotchas section. This file is a complete, ordered work plan. Do the phases IN ORDER, and after EVERY phase run both:

```
npm run check:types
node scripts/agent-evals.mjs
```

Both must pass before moving on. Commit at the end of each phase with a `feat(phase29): …` message.

## Hard invariants — do not violate, do not "clean up"
- `src/libs/mcp/stdioClient.ts` must NEVER spread `...process.env` into a child env.
- Unknown MCP tool policy must keep defaulting to `'approval'` in `src/libs/mcp/registry.ts`.
- Keep all transcript markers exactly as-is: `[budget]`, `[stopped]`, `[continuing]`, `[system]`, `[tool]`, `[approval]`, `✓ Approved:`.
- Keep `postWithRetry` in `anthropic.ts`, the `stop_reason === 'max_tokens'` recovery in `loop.ts`, and both `cache_control` breakpoints (system + last user block).
- Do not touch existing migrations `0000`–`0017` or `migrations/meta/_journal.json`.
- Do not reformat files you aren't changing. LF line endings in this repo.
- `scripts/agent-evals.mjs` is the incident-regression suite: when you change guarded code, UPDATE the suite in the same commit (never delete a tripwire without replacing it), and ADD the new tripwires listed at the bottom.

---

## Phase 0 — cron workflow (verify or apply)

There is a file `agent-cron.yml.new` in the repo root. Check `.github/workflows/agent-cron.yml`:
- If it already contains `cron: '*/10 * * * *'`, the update is done — just `git rm agent-cron.yml.new`.
- If it still says `*/30`, replace `.github/workflows/agent-cron.yml` with the contents of `agent-cron.yml.new`, then delete `agent-cron.yml.new`.

## Phase 1 — decouple agent execution from the browser connection (THE stall fix)

**Bug being fixed:** `src/app/api/agent/chat/route.ts` treats ANY client disconnect as Stop — the stream's `cancel()` sets `cancelled = true` and the tool loop halts. A page REFRESH aborts the stream, so the user refreshing to check progress has been silently killing the run. Stop must become an explicit signal; disconnect must become harmless.

1. **New file `src/libs/agent/activeTurns.ts`** — in-memory registry (single-container by design, same reasoning as `rateLimit.ts`; say so in a comment):
```ts
type ActiveTurn = { tenantId: string; startedAt: number; iteration: number; lastTool: string | null; stopRequested: boolean };
```
Module-level `Map<string /*conversationId*/, ActiveTurn>` with: `beginTurn(conversationId, tenantId)`, `noteProgress(conversationId, iteration, lastTool)`, `requestStop(conversationId): boolean` (false if no active turn), `isStopRequested(conversationId)`, `getTurn(conversationId): ActiveTurn | null`, `endTurn(conversationId)`. Cap the map at 500 entries (evict oldest) as a leak guard.

2. **`src/libs/agent/loop.ts`** — add optional `onProgress?: (iteration: number, lastTool: string | null) => void` to the options. Call it at the top of every iteration (with the last executed tool name from the previous iteration, or null on the first). Keep `shouldStop` exactly as it is — only its SOURCE changes.

3. **`src/app/api/agent/chat/route.ts`**:
   - Delete the `let cancelled = false` flag and the `cancel() { cancelled = true }` handler body. `cancel()` should remain but only as a comment-documented no-op ("client went away — keep working; the message persists via the finally block and the user picks it up from history").
   - Around the `runToolLoop` call: `beginTurn(conversationId, tenant.id)` before, `endTurn(conversationId)` in the `finally`. Pass `shouldStop: () => isStopRequested(conversationId)` and `onProgress: (i, t) => noteProgress(conversationId, i, t)`.
   - The existing try/catch around `controller.enqueue` already tolerates a dead client — keep it. The message-persistence `finally` block already runs after disconnect on Railway (Node keeps executing the handler) — keep it, and note this in a comment.

4. **New route `src/app/api/agent/stop/route.ts`** — `POST { tenantSlug }`: `getCurrentUser` → membership check via `getUserTenants` (any member may stop their own conversation) → find the user's conversation for that tenant (same query as the chat route) → `requestStop(conversationId)` → `{ ok, stopping: boolean }`. The loop emits `[stopped]` on its next iteration exactly as before.

5. **New route `src/app/api/agent/status/route.ts`** — `GET ?tenant=slug`: auth + membership → find conversation → `getTurn(conversationId)` → `{ active: boolean, iteration, lastTool, startedAt, stopRequested, elapsedMs }` (nulls when inactive).

6. **`src/features/agent/AgentChat.tsx`**:
   - Stop button now calls `POST /api/agent/stop` (keep the local `abortRef.abort()` too so the UI unblocks instantly — the server no longer interprets the abort as stop).
   - Add a status poller: when NOT currently streaming, poll `/api/agent/status?tenant=…` every 5s. If `active`, show a working indicator in the chat (reuse the typing-dots row): `Working — {iteration} tool calls · last: {lastTool} · {mm:ss} elapsed`, disable the composer, and show the Stop button. When `active` flips false after having been true, call `loadHistory()` so the finished message appears. This makes a refreshed page RESUME showing live progress instead of looking dead.

## Phase 2 — Missions panel + runner health (visibility)

1. **New file `src/libs/agent/runnerHealth.ts`** — module-level `let lastTickAt: number | null`; `markTick()`, `getLastTickAt()`. In `src/app/api/internal/run-scheduled/route.ts`, call `markTick()` at the top of the handler. (Same single-process assumption; resets on deploy — that's fine, the UI says "no tick since last deploy".)

2. **`src/app/api/missions/route.ts`**:
   - GET: include `lastTickAt: getLastTickAt()` in the response.
   - PATCH: add a third action `'cancel'` (editor+): remaining `pending`/`running` steps → `'skipped'` with result `'Cancelled from dashboard'`, mission → `'done'`. Mirror the logic in `set_mission_status` in `src/libs/agent/missionTools.ts` (use `inArray`).

3. **New component `src/features/agent/MissionsPanel.tsx`** (follow the visual conventions of `ApprovalsPanel.tsx` — glass card, same polling style):
   - Poll `GET /api/missions?tenant=` every 20s.
   - Per mission: title, status chip (running=emerald pulse, paused=amber, done=muted), **progress bar** = (done+skipped)/total steps with the fraction printed, the currently `running` step's title if any, and "updated Xm ago" from `updatedAt`.
   - Buttons for editor+: Pause / Resume / Cancel (Cancel needs a confirm), calling PATCH with the action.
   - Header shows runner health from `lastTickAt`: green "runner ticked Xm ago" if < 25 min, amber "no tick in Xm — check GitHub Actions" if older, grey "no tick since last deploy" if null.
   - Hide the whole panel when there are no missions and health is fine.
   - Mount it in the dashboard side rail directly ABOVE `ApprovalsPanel` (find where ApprovalsPanel is rendered and add it there, same visibility rules).

## Phase 3 — token diet

1. **Tool-result eviction (`src/libs/agent/loop.ts`)**: long turns currently re-send every old tool result on every iteration. After appending each iteration's tool results, walk `messages`: identify user-role messages that carry `tool_result` blocks; for all such messages EXCEPT the 6 most recent, replace each `tool_result` block's `content` with the string `'[tool result elided to save context — call the tool again if you need it]'` — but ONLY if the original content is longer than 2,000 characters, and NEVER remove or reorder blocks (the API requires every tool_use to keep its tool_result). Add a comment: this busts the message-suffix cache once per eviction, which is strictly cheaper than dragging the payload through every remaining iteration.

2. **Deferred MCP tool loading (`src/libs/mcp/registry.ts` + `src/libs/agent/prompt.ts`)** — the biggest cost lever: the full tool catalog (~77k tokens; Zernio alone is 51 schemas, DiviOps 74) is re-sent on every model call even when unused.
   - In `buildTenantToolset`: for each connection whose tool count is **≥ 10**, do NOT include its tool schemas in `anthropicTools`. Instead collect `deferred: Array<{ connection: string, toolNames: string[] }>` and add ONE meta-tool `load_connection_tools` `{ connection: string }` (policy auto). Its executor finds the deferred connection, pushes its full schemas into the SAME `anthropicTools` array instance (the loop passes `a.toolset.anthropicTools` on every call, so mutation takes effect next iteration), registers its executors for `resolve`, and returns `"Loaded N tools from <connection>: <names>. They are available from your next step."`. Keep an env escape hatch: if `DISABLE_TOOL_DEFERRAL=1`, behave exactly as today.
   - The toolset return type gains `deferredSummary: string` (e.g. `"zernio (51 tools: posts-create, …first 8 names…), diviops (74 tools: …)"`) — empty string when nothing deferred.
   - All three assemblers (chat route, approvals route `resumeConversation`, run-scheduled `assembleToolset`) must surface `deferredSummary` to the model: append a short paragraph to the system prompt (chat route already appends `imageTrustNote()` conditionally — same pattern): `"Some tool collections are DEFERRED to keep context small: <summary>. Call load_connection_tools with the connection name before using them."`.
   - `resolve()` must still find a deferred connection's tool if the model calls it WITHOUT loading first (return a helpful error from the gateway is wrong — instead auto-load on resolve and execute normally; the deferral is a token optimization, never a functional wall).
   - Note in comments: expanding tools busts the tools+system cache prefix once — accepted trade.

3. **Step sizing** — in `src/libs/agent/missionTools.ts` `start_mission` description AND the MISSIONS paragraph in `src/libs/agent/prompt.ts`, add: size each step so it needs **at most ~12 tool calls**; a step like "write and commit 3 articles" is right, "write 20 articles" is wrong and will be cut off mid-work.

## Phase 4 — evals + docs (same commit discipline as every prior phase)

Add tripwires to `scripts/agent-evals.mjs` (follow the existing `expect/forbid` style, one-line "guards:" reasons referencing this phase):
- `src/app/api/agent/chat/route.ts` contains `isStopRequested` (stop is explicit) and does NOT contain `cancelled = true` (use `forbid`; comment-stripping is already handled).
- `src/app/api/agent/stop/route.ts` contains `requestStop`.
- `src/app/api/agent/status/route.ts` contains `getTurn`.
- `src/libs/agent/loop.ts` contains `elided to save context`.
- `src/libs/mcp/registry.ts` contains `load_connection_tools`.
- `src/features/agent/MissionsPanel.tsx` contains `lastTickAt`.
- `src/libs/agent/missionTools.ts` contains `12 tool calls`.

Update the assertion count anywhere it's stated, add a **Phase 29** section to `CLAUDE.md` (cause → fix, in the style of Phases 27–28.2, including the refresh-kills-work root cause), and update `docs/PRODUCTION_READINESS_UAT.md`: A3 note (Stop is now explicit; disconnect-safe), F4 → ⚠️ (live turn status shipped; full trace view still open), I6 → ⚠️ (missions panel shipped; push notifications still open), plus a UAT test: "start a long task, REFRESH the page → progress indicator reappears and the task completes".

## Final verification
1. `npm run check:types` — clean.
2. `node scripts/agent-evals.mjs` — all tripwires pass.
3. `npm run build:next` — builds.
4. Commit everything; summarize per-phase what changed in the final message.
