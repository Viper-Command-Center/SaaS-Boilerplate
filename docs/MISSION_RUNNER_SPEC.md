# Mission Runner — design spec (Phase 27 candidate)

Status: SPEC ONLY (2026-08-02). Phase 26 shipped the stopgaps — bigger loop
budget, honest exhaustion, and exhausted-scheduled-task fast requeue. This doc
is the full design for turning Artivio agents from "chat loop" into "task
runner": the difference between an agent that is great at turn-sized work
(social posts) and one that completes a 6-week dashboard build overnight,
unattended, the way Claude Code completes multi-hour engineering tasks.

## Why (the Max incident, 2026-07-30)
Ryan asked Max to build a 6-week growth-sprint tracker. The work needed ~30+
tool calls; the loop allowed 8 iterations; the turn ended silently at week 2.
Two structural facts caused this, and Phase 26 only softened them:
1. Work lives in a REQUEST. A Next route owns the loop; when the request ends
   (budget, timeout, deploy, crash) the work ends with it, stateless.
2. The plan lives in the MODEL'S HEAD. Nothing on the platform knows the task
   was "6 weeks", so nothing can measure progress, resume, or report % done.

## Shape: missions = plan + checkpointed executor

### Schema (one migration)
- `missions`: id, tenantId, conversationId?, title, goal (the user's ask,
  verbatim), status (planning|running|waiting_approval|paused|done|failed),
  createdBy, createdAt, updatedAt.
- `mission_steps`: id, missionId, position, title, instructions (complete,
  standalone — same rule as scheduled-task prompts), status
  (pending|running|done|failed|skipped), result (text, ≤4k), attempts,
  updatedAt.

### Agent-facing tools (platformTools)
- `start_mission(title, goal, steps[])` — the agent PLANS FIRST: it must
  decompose the goal into steps before executing. Creating the mission is the
  plan's persistence. Policy `auto`.
- `update_mission_step(stepId, status, result?)` — the checkpoint write.
- `list_missions` / `get_mission(id)` — resume context for any future run.

### Executor
Reuse the run-scheduled pattern (it already claims work, tolerates crashes,
and shares the tool loop + approvals gateway):
- The cron tick picks up to N missions with status `running`, takes the FIRST
  pending step, and runs ONE step per tick through `runToolLoop` with the step
  instructions + `get_mission` context as the prompt. One step per tick keeps
  each request small, cheap to retry, and inside route limits — the mission's
  durability comes from the DB, not from a long-lived process.
- Step exhausted (loop returns `exhausted: true`) → step stays `running`,
  wrap-up text appended to its result, next tick continues it (same
  continuation mechanic Phase 26 gave scheduled tasks).
- Step failed → attempts += 1; after 2 attempts mark step `failed`, mission
  `paused`, and notify (support/notify.ts) — a human decides, the mission
  never thrashes.
- Approval-gated tool inside a step → mission status `waiting_approval`; the
  approvals route (which already resumes conversations on both outcomes)
  additionally flips the mission back to `running`.

### Chat integration
When a chat request would exceed its budget on a big ask, the agent's
instructed move is: `start_mission` + tell the user "this is now running in
the background — watch the Missions panel". The turn ends honestly and the
work continues without the browser tab.

### UI
One "Missions" panel (same grid): title, progress (done/total steps), status,
last update. Click-through to step list. The human controls pause/resume —
the Phase 21/24 rule (every agent mechanism gets a human control).

### Guardrails (all existing, reused)
- checkSpend() gates every iteration of every step — daily cap is the real
  ceiling on an unattended mission.
- Approvals gateway unchanged — a mission cannot bypass tool policy.
- Steps carry complete instructions — a mission survives deploys and restarts
  because nothing lives only in a request or a context window.

## Explicitly out of scope
- Parallel step execution (sequential is enough; parallelism multiplies
  failure modes before the basics have soaked).
- Sub-agents / nested missions.
- Replacing scheduled tasks — recurring work stays scheduled tasks; missions
  are finite jobs with an end state.

## Effort estimate
1 migration + ~3 files touched (platformTools, run-scheduled or a sibling
route, one panel component) + prompt.ts guidance. Roughly one focused session.
