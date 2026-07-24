# Audit — panels + MCP layer (2026-07-16)

Triggered by Ryan: *"We keep finding more and more bugs in the panel whenever we add an MCP Server or something else."*

Two parallel audits (dashboard/panels, MCP/tools). Everything below was **verified by reading the code**, not inferred.

---

## The pattern — one disease, many symptoms

Every bug in this audit is an instance of **the platform's success signals not depending on success**.

| Where | What it claims | What's true |
|---|---|---|
| `markdown` panel | renders markdown | printed raw text (fixed, Phase 24) |
| `table` panel | `limit?: number` | hardcoded to 8 rows |
| `create_panel` | "created and visible" | never validates `config` at all |
| `num()` in timeseries | plots your data | plots `"1,234"` as **0**, confidently |
| `kpi` | shows a metric | shows the literal string **"null"** in 4xl gradient |
| registry | "failure-tolerant" | true only for servers that fail LOUDLY |
| `buildTenantToolset` | succeeded | may have poisoned the tools array → whole request 400s |
| `reload()` | refreshes | wipes the dashboard on any error |

The agent isn't hallucinating. **It is faithfully relaying a platform that lies to it**, and then apologising for our bugs. That's the through-line from the Ntropy `"unknown"` money leak, to the Kie video model, to the markdown panel, to today.

**The structural rule this suggests:** a success message must be a function of the thing having worked. `create_panel` returning "created and visible" without reading `config` is the same defect as `model: {type:'string'}` in Phase 22 — an open field the agent cannot inspect, with a success signal that doesn't depend on it being right.

---

## FIXED in this session

| # | Fix | File |
|---|---|---|
| 1 | **`AbortSignal.timeout` on every MCP call** (15s list / 120s call) — there was NO timeout | `mcp/client.ts` |
| 2 | **`namespacedToolName()`** sanitizes + length-checks third-party tool names; illegal ones are skipped and reported instead of poisoning the array | `mcp/registry.ts` |
| 3 | **`failedConnections` moved out of the cached system block** (was busting ~77k tokens every turn) | `api/agent/chat/route.ts` |
| 4 | **`.orderBy(name)`** on the connections query — cache key stability | `mcp/registry.ts` |
| 5 | **Failed poll keeps the last good render + shows a banner** (was blanking the whole dashboard) | `PanelsGrid.tsx` |
| 6 | **`table` honours `limit`**, caps visual height not data, empty state, flags hidden columns | `PanelsGrid.tsx` |

---

## OPEN — ranked

### 🔴 HIGH

**1. `PATCH /api/mcp/connections/[id]` bypasses the name rules.**
`name: z.string().min(1).max(60).optional()` — no regex (POST has one), no `.toLowerCase()` (POST has one), and `max(60)` vs POST's `max(80)`.
Consequence: the unique index `(tenantId, name)` is on the raw string, so `"GitHub"` and `"github"` **coexist**. Both `sanitize()` to `github` → identical namespaced tool names → (a) `executors.set()` silently overwrites, so **a tool call can hit the wrong server with the wrong credential**, and (b) duplicate names in the tools array → Anthropic 400 → whole chat dead.
Fix: add the POST regex, add `.toLowerCase()`, align max. 3 lines.

**2. `mcpConnections.name` is `varchar(80)`.**
`mcp__` (5) + 80 + `__` (2) = 87 chars **before the tool name**, against a 64 limit. `namespacedToolName()` now refuses these rather than 400ing, but the user gets a connection whose tools silently don't exist. Lower the column + the zod max to ~40 and validate at the form.

### 🟡 MEDIUM-HIGH

**3. `config` is never validated on `create_panel`/`update_panel`.**
`config: { type: 'object' }` — free-text. `datasetKey` vs `dataset_key`, `valueField` vs `field` — all accepted, all produce a dead card, all reported as "created and visible". **This is the Phase 22 lesson unapplied.** Validate per type; reject unknown keys; make the success message conditional.

**4. `num()` silently converts unparseable values to 0.**
`"1,234"` → 0. `"12%"` → 0. `"N/A"` → 0. Exactly what an agent scraping a page writes. The chart draws a confident line at zero **with a delta badge**, and nothing looks broken. Worst kind of lie — wrong data presented as correct.

**5. `kpi` renders `null` as "null"** and objects as `[object Object]`, in 4xl gradient numerals. Only `undefined` gets the em-dash.

### 🟢 MEDIUM

**6. `GET /api/panels` is an N+1 on a 30s poll, for every tab including hidden ones.**
60 panels = **61 queries every 30 seconds per open dashboard**, ~48 for tabs nobody's looking at. Scope to the active view, or one grouped query. Combined with the pool, this is a realistic trigger for #5-fixed's "dashboard vanished".

**7. Connections are listed SERIALLY, with no caching.**
5 connections × 3 round-trips (initialize → initialized → tools/list) ≈ **6 seconds of dead air before the first token, on every message**. `Promise.allSettled` → ~1.2s; a short-TTL cache → ~0. The tool list changes maybe monthly.

**8. `buildTenantToolset` runs TWICE per approval** (`approvals/[id]/route.ts:76` and `:187`). Full re-init + re-list of every server, doubled, on one click.

**9. `persist()` never checks the response.** `fetch` doesn't reject on 4xx, so the `catch` can't fire for a 400/403 — the drag appears to work and silently reverts 30s later. Also PATCHes **all** panels, not just the moved one, so >200 breaks drag entirely (`MoveSchema.max(200)`), forever, invisibly.

**10. `create_panel` defaults `position: 0`** → every agent-created panel inserts itself at the **top**, displacing a human's arrangement. Directly contradicts the prompt telling it to treat manual layout as intentional.

**11. `width` is agent-only.** `MoveSchema` has no `width`; the PATCH never writes it. A user who thinks a table is too narrow must ask the agent. *(The recurring rule: if a mechanism is wired to the agent, wire a control to the human in the same change. Fourth instance.)*

### ⚪ LOW

- `timeseries` says "Waiting for data…" when 1 row exists — the wording lies; it needs 2+ points for a line.
- `table`/`kpi` have no empty state distinguishing "no data yet" from "typo'd datasetKey". *(table fixed; kpi open)*
- Unknown panel `type` falls through to the table branch.
- `NAME_RE` in `resolve()` is dead code — it runs and discards both capture groups. Harmless, but someone will later "fix" it into a real parse and reintroduce an asymmetry.
- `config.limit` is honoured by the API for `timeseries` but never advertised to the agent.
- First drag writes `viewId` onto every unfiled panel (derived value round-tripped as if stored), undoing `delete_view`'s "panels become unfiled" promise.
- Connection-name zod error is swallowed by `catch { 'Invalid request.' }` — the user isn't told spaces are the problem.

---

## Verified correct — do not re-flag

- **SPAN map** — all static literals, no template-built class names, `clampWidth` bounds 1–3 on all three write paths.
- **0 views / deleted-view re-home** — works, and matches what `delete_view` tells the agent.
- **`frozen` ref** — correctly checked before the fetch AND inside the `.then`. `collapsed`/`folded`/`activeView` are localStorage-backed and untouched by the poll.
- **timeseries divide-by-zero** — `range = max - min || 1` and the `< 2` early return both guard correctly.
- **`policy: policyMap[tool.name] ?? policyMap['*'] ?? 'approval'`** — correct and well-reasoned.
- **`prompt.ts` has no timestamps** — the static system prompt is genuinely cacheable.
- **`resolve()` symmetry** — a plain Map lookup on the exact built string; symmetric by construction.
- **Per-connection try/catch** — genuinely isolates servers that error or refuse. The gap was only hangs (fixed) and array poisoning (fixed).
- **`Markdown.tsx` paragraph loop** — break conditions are strictly identical to the block branches above; cannot infinite-loop.

---

## Not checked (honest scope limits)

- `/api/plugins` POST vs the `(tenantId, name)` unique index — a collision with a hand-created connection is **likely a 500**. Inferred, not verified.
- `ToolsPanel.tsx` client-side validation.
- `/api/mcp/test`.
- Builtin providers' own tool-name legality (`kie.ts`, `wordpress.ts`, `agentcoreBrowser.ts`) — ours, so lower risk, but unread. `namespacedToolName()` now reports them rather than 400ing.
- The scheduled-task path (`run-scheduled`) got the same `buildTenantToolset`, so it inherits the fixes, but its own error handling wasn't audited.

---

## The durable fix

**Tool filtering / progressive disclosure** — load only the tools a request plausibly needs instead of all 80+. It cuts cost AND improves selection accuracy (which degrades as the list grows). It gets more valuable with every MCP connected, which is the entire product direction.

But it is **strictly less urgent than the cache-busting fixes above** — there's no point compressing a prefix that was being rewritten in full every turn anyway. That's now fixed; measure before building this.
