/**
 * POST /api/internal/run-scheduled — cron entrypoint for scheduled agent
 * tasks. Protected by the CRON_SECRET env var (header `x-cron-secret`).
 * Triggered by the repo's GitHub Actions workflow (or any external cron).
 *
 * Executes up to 3 due tasks per invocation through the same tool loop +
 * approvals gateway as chat. Each run is stateless: the task's stored prompt
 * is the complete instruction set.
 *
 * CONTINUATION (Phase 26): missions get a bigger tool budget than chat
 * (40 iterations), and when a run ends EXHAUSTED — budget spent while the
 * model still had work to do — the task is requeued for ~5 minutes from now
 * instead of waiting a full interval. The run's wrap-up summary ("done X,
 * remaining Y") is stored in lastResult and fed to the next run, so it picks
 * up where this one stopped instead of starting cold. This is what lets a
 * 6-week dashboard build finish overnight instead of stopping at week 2.
 * Runaway protection: checkSpend() gates every iteration, so continuation
 * rounds stop the moment the workspace hits its daily cap.
 *
 * MISSION STEPS (Phase 27, docs/MISSION_RUNNER_SPEC.md): after the scheduled
 * tasks, this route executes ONE step of ONE running mission per tick. A
 * mission is a plan the agent persisted via start_mission — each step carries
 * complete standalone instructions, so the executor needs no chat history.
 * Bookkeeping is the RUNNER'S job, not the model's: success marks the step
 * done; an exhausted budget leaves it running with the wrap-up appended (next
 * tick continues it); a thrown error bumps attempts, and the second failure
 * marks the step failed and PAUSES the whole mission for a human — silent
 * retry loops on a broken step are how money disappears overnight.
 */

import { and, asc, eq, lte } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { runToolLoop } from '@/libs/agent/loop';
import { buildMissionTools } from '@/libs/agent/missionTools';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { buildSystemPrompt } from '@/libs/agent/prompt';
import { markTick } from '@/libs/agent/runnerHealth';
import { captureIssue } from '@/libs/support/issues';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { missions, missionSteps, scheduledTasks, tenants } from '@/models/Schema';


export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_TASKS_PER_TICK = 3;
const MISSION_MAX_ITERATIONS = 40;
const MISSION_WALL_CLOCK_MS = 4 * 60_000;
const CONTINUATION_DELAY_MS = 5 * 60_000;
// ── Tick time budgeting (Phase 28.2 — the mission-starvation fix) ──────────
// This runs on Railway (a plain Node server), so Next's maxDuration is not a
// hard kill and the GitHub curl disconnecting doesn't stop the handler. The
// real constraint is the NEXT tick: stay comfortably inside the cron
// interval so ticks never overlap. Budget: tasks get the first slice,
// missions are GUARANTEED the rest — before this, 3 slow scheduled tasks
// (4 min each) plus a single-step mission slot meant 4 concurrent missions
// crawled at one step every ~2 hours, which read as "stalled" to the user.
const TASKS_TIME_BUDGET_MS = 9 * 60_000;
const TOTAL_TIME_BUDGET_MS = 22 * 60_000;
const MAX_MISSION_STEPS_PER_TICK = 4;
// A step left 'running' with a FRESH updatedAt is (probably) executing in an
// overlapping/previous tick — don't double-run it; only resume once stale.
const STEP_STALE_MS = 10 * 60_000;
const MAX_STEP_ATTEMPTS = 2;

/** Merge platform + mission + MCP tools into one resolvable toolset. */
async function assembleToolset(tenantId: string) {
  let mcpToolset: Awaited<ReturnType<typeof buildTenantToolset>>;
  try {
    mcpToolset = await buildTenantToolset(tenantId);
  } catch {
    mcpToolset = { anthropicTools: [], failedConnections: [], connectionGuidance: '', resolve: () => null, deferredSummary: '', attachToolSink: () => {} };
  }
  const platform = buildPlatformTools(tenantId);
  const mission = buildMissionTools(tenantId);
  // 🔴 PHASE 29.1 — the combined array is what the loop sends to the model on
  // every iteration, so load_connection_tools must push newly-loaded schemas
  // into THIS array too, not just the registry's own. Without the sink the
  // model is told "Loaded 51 tools" and then cannot see any of them.
  const combinedTools = [...platform.anthropicTools, ...mission.anthropicTools, ...mcpToolset.anthropicTools];
  mcpToolset.attachToolSink(combinedTools);
  return {
    anthropicTools: combinedTools,
    failedConnections: mcpToolset.failedConnections,
    // Surface deferred MCP collections (Phase 29) so the mission/task prompt can
    // tell the model they exist and how to load them.
    connectionGuidance: mcpToolset.connectionGuidance,
    deferredSummary: mcpToolset.deferredSummary,
    attachToolSink: mcpToolset.attachToolSink,
    resolve: (name: string) => {
      const p = platform.executors.get(name) ?? mission.executors.get(name);
      if (p) {
        return { connectionId: '', connectionName: 'platform', toolName: name, policy: p.policy, call: p.call };
      }
      return mcpToolset.resolve(name);
    },
  };
}


export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || request.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Runner heartbeat (Phase 29): record that a tick happened so the Missions
  // panel can show "runner ticked Xm ago" and flag a stalled cron.
  markTick();

  const tickStartedAt = Date.now();


  const due = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, new Date())))
    .orderBy(asc(scheduledTasks.nextRunAt))
    .limit(MAX_TASKS_PER_TICK);

  const results: Array<{ id: string; name: string; ok: boolean; continued?: boolean }> = [];

  for (const task of due) {
    // Tasks may not eat the missions' time slice. An unclaimed task is still
    // due next tick — nothing is lost by deferring it.
    if (Date.now() - tickStartedAt > TASKS_TIME_BUDGET_MS) {
      break;
    }
    // Claim immediately so overlapping cron ticks don't double-run it.
    await db
      .update(scheduledTasks)
      .set({ nextRunAt: new Date(Date.now() + task.intervalMinutes * 60_000), lastRunAt: new Date() })
      .where(eq(scheduledTasks.id, task.id));

    let output = '';
    let ok = true;
    let continued = false;
    try {
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, task.tenantId)).limit(1);
      if (!tenant) {
        throw new Error('Tenant gone');
      }

      const toolset = await assembleToolset(tenant.id);

      // Same employee runs the 3am mission as runs the chat — with the same
      // standing workspace memory (Phase 28).
      const agent = await resolveAgentForTenant(tenant.id);
      let system = `${buildSystemPrompt({ tenant: { ...tenant, role: 'owner' }, agent, memory: tenant.agentMemory })}

This is an AUTOMATED SCHEDULED RUN of your standing task "${task.name}" — no
human is watching live. Do the work now with your tools. Anything requiring
approval will queue in the Approvals inbox. Keep the final summary short; it
is stored as the run's result. If useful, record progress via write_dataset.
If your tool budget runs out mid-task, summarise honestly what remains — the
platform will requeue you within minutes to continue from that summary.`;
      // Deferred MCP collections (Phase 29): tell the model they exist + how to load.
      if (toolset.deferredSummary) {
        system += `\nSome tool collections are DEFERRED to keep context small: ${toolset.deferredSummary}. Call load_connection_tools with the connection name before using them.`;
      }
      // Phase 32: cross-tool operating notes from the built-in providers this
      // workspace enabled. Versioned with the adapter, so a trap fixed once is
      // fixed for every client site — see BuiltinProvider.guidance.
      if (toolset.connectionGuidance) {
        system += `\n\n## How your connected tools actually behave\n${toolset.connectionGuidance}`;
      }


      // A continuation run starts from the previous run's honest wrap-up
      // instead of cold — the [continuing] marker is set below only when the
      // previous run exhausted its budget.
      const isContinuation = (task.lastResult ?? '').startsWith('[continuing]');
      const userText = isContinuation
        ? `${task.prompt}

[system] A previous run of this task ran out of tool budget. Its closing status:
${(task.lastResult ?? '').slice(0, 3_000)}

Check the current workspace state with your read tools (list_views, list_panels, query_dataset) before creating anything, then CONTINUE from where that run stopped. Do not redo completed work.`
        : task.prompt;

      const run = await runToolLoop({
        tenantId: tenant.id,
        conversationId: '',
        system,
        history: [],
        userText,
        toolset,
        onDelta: () => {},
        maxIterations: MISSION_MAX_ITERATIONS,
        wallClockMs: MISSION_WALL_CLOCK_MS,
      });
      output = run.text;

      // Exhausted = unfinished. Requeue soon (not a full interval away) and
      // mark the stored result so the next run knows it is a continuation.
      if (run.exhausted) {
        continued = true;
        output = `[continuing] ${output}`;
        await db
          .update(scheduledTasks)
          .set({ nextRunAt: new Date(Date.now() + CONTINUATION_DELAY_MS) })
          .where(eq(scheduledTasks.id, task.id));
      }
    } catch (err) {
      ok = false;
      output = `Run failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    }

    await db
      .update(scheduledTasks)
      .set({ lastResult: output.slice(0, 4000) })
      .where(eq(scheduledTasks.id, task.id));
    results.push({ id: task.id, name: task.name, ok, ...(continued ? { continued } : {}) });
  }

  // ── Mission steps (Phase 27; multi-step ticks since Phase 28.2) ──────────
  // Up to MAX_MISSION_STEPS_PER_TICK steps per tick, each time re-selecting
  // the least-recently-touched running mission (claiming rotates it to the
  // back, so several missions share a tick fairly instead of one step per
  // 30 minutes across ALL of them).
  const missionResults: Array<{ missionId: string; stepId: string; outcome: string }> = [];

  for (let slot = 0; slot < MAX_MISSION_STEPS_PER_TICK; slot++) {
    // Leave room for the step we're about to run — never risk tick overlap.
    if (Date.now() - tickStartedAt > TOTAL_TIME_BUDGET_MS - MISSION_WALL_CLOCK_MS) {
      break;
    }

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.status, 'running'))
      .orderBy(asc(missions.updatedAt)) // least-recently-touched first = fair
      .limit(1);
    if (!mission) {
      break;
    }

    const steps = await db
      .select()
      .from(missionSteps)
      .where(eq(missionSteps.missionId, mission.id))
      .orderBy(asc(missionSteps.position));

    const open = steps.filter(s => s.status === 'running' || s.status === 'pending');
    if (open.length === 0) {
      // Every step is terminal (done/skipped/failed-but-mission-resumed) —
      // close the mission out.
      await db
        .update(missions)
        .set({ status: 'done', updatedAt: new Date() })
        .where(eq(missions.id, mission.id));
      missionResults.push({ missionId: mission.id, stepId: '', outcome: 'mission-done' });
      continue;
    }

    // A STALE 'running' step is a previous tick's exhausted (or crashed) step
    // — resume it. A FRESH 'running' step is likely mid-flight in another
    // invocation; don't double-run it — rotate this mission to the back and
    // give the slot to a different mission.
    const step = steps.find(s =>
      s.status === 'running' && Date.now() - new Date(s.updatedAt).getTime() > STEP_STALE_MS,
    ) ?? steps.find(s => s.status === 'pending');

    if (!step) {
      await db.update(missions).set({ updatedAt: new Date() }).where(eq(missions.id, mission.id));
      missionResults.push({ missionId: mission.id, stepId: '', outcome: 'in-flight-skip' });
      continue;
    }

    const resuming = step.status === 'running' && !!step.result;
    // Claim before running (same rule as scheduled tasks: overlapping ticks
    // must not double-run). Touching the mission's updatedAt also rotates it
    // to the back of the fairness queue.
    await db.update(missionSteps).set({ status: 'running', updatedAt: new Date() }).where(eq(missionSteps.id, step.id));
    await db.update(missions).set({ updatedAt: new Date() }).where(eq(missions.id, mission.id));

    try {
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, mission.tenantId)).limit(1);
      if (!tenant) {
        throw new Error('Tenant gone');
      }

      const toolset = await assembleToolset(tenant.id);
      const agent = await resolveAgentForTenant(tenant.id);
      let system = `${buildSystemPrompt({ tenant: { ...tenant, role: 'owner' }, agent, memory: tenant.agentMemory })}

This is an AUTOMATED MISSION STEP RUN — no human is watching live. You are
executing ONE step of the mission "${mission.title}" (goal: ${mission.goal.slice(0, 500)}).
Overall plan status:
${steps.map(s => `${s.position + 1}. [${s.status}] ${s.title}`).join('\n')}

Do ONLY the step given below — later steps run in their own turns. Anything
requiring approval will queue in the Approvals inbox; if a tool call queues
for approval, note it and finish what else you can. Keep the final summary
short and concrete (what was produced, where) — it is stored as the step's
result. If your tool budget runs out, summarise honestly what remains; the
platform will continue this step on the next run.`;
      // Deferred MCP collections (Phase 29): tell the model they exist + how to load.
      if (toolset.deferredSummary) {
        system += `\nSome tool collections are DEFERRED to keep context small: ${toolset.deferredSummary}. Call load_connection_tools with the connection name before using them.`;
      }
      // Phase 32: cross-tool operating notes from the built-in providers this
      // workspace enabled. Versioned with the adapter, so a trap fixed once is
      // fixed for every client site — see BuiltinProvider.guidance.
      if (toolset.connectionGuidance) {
        system += `\n\n## How your connected tools actually behave\n${toolset.connectionGuidance}`;
      }


      const userText = resuming
        ? `Step ${step.position + 1}: ${step.title}

${step.instructions}

[system] A previous run of THIS STEP ran out of tool budget. Its closing status:
${(step.result ?? '').slice(0, 3_000)}

Check the current workspace state with your read tools (list_views, list_panels, query_dataset, list_files) before creating anything, then CONTINUE from where it stopped. Do not redo completed work.`
        : `Step ${step.position + 1}: ${step.title}

${step.instructions}`;

      const run = await runToolLoop({
        tenantId: tenant.id,
        conversationId: '',
        system,
        history: [],
        userText,
        toolset,
        onDelta: () => {},
        maxIterations: MISSION_MAX_ITERATIONS,
        wallClockMs: MISSION_WALL_CLOCK_MS,
      });

      if (run.exhausted) {
        // Unfinished, not failed: keep it 'running' with the wrap-up stored —
        // the next tick finds the running step and continues from it.
        await db
          .update(missionSteps)
          .set({ result: run.text.slice(0, 4_000), updatedAt: new Date() })
          .where(eq(missionSteps.id, step.id));
        missionResults.push({ missionId: mission.id, stepId: step.id, outcome: 'continuing' });
      } else {
        await db
          .update(missionSteps)
          .set({ status: 'done', result: run.text.slice(0, 4_000), updatedAt: new Date() })
          .where(eq(missionSteps.id, step.id));
        const openSteps = steps.filter(s => s.id !== step.id && (s.status === 'pending' || s.status === 'running'));
        if (openSteps.length === 0) {
          await db
            .update(missions)
            .set({ status: 'done', updatedAt: new Date() })
            .where(eq(missions.id, mission.id));
          missionResults.push({ missionId: mission.id, stepId: step.id, outcome: 'done+mission-done' });
        } else {
          missionResults.push({ missionId: mission.id, stepId: step.id, outcome: 'done' });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      const attempts = step.attempts + 1;
      if (attempts >= MAX_STEP_ATTEMPTS) {
        // Second strike: stop the whole mission and put a human in the loop.
        // The step's real error is stored on the step AND captured as an
        // Issue — retrying a broken step forever burns budget on nothing.
        await db
          .update(missionSteps)
          .set({ status: 'failed', attempts, result: `Failed after ${attempts} attempts: ${message}`.slice(0, 4_000), updatedAt: new Date() })
          .where(eq(missionSteps.id, step.id));
        await db
          .update(missions)
          .set({ status: 'paused', updatedAt: new Date() })
          .where(eq(missions.id, mission.id));
        await captureIssue({
          tenantId: mission.tenantId,
          source: `mission-step: ${mission.title} / ${step.title}`.slice(0, 160),
          error: err instanceof Error ? err : new Error(message),
          detail: { missionId: mission.id, stepId: step.id, attempts },
        }).catch(() => {});
        missionResults.push({ missionId: mission.id, stepId: step.id, outcome: 'failed+paused' });
      } else {
        // First strike: back to pending — the next tick retries it once.
        await db
          .update(missionSteps)
          .set({ status: 'pending', attempts, result: `Attempt ${attempts} failed: ${message}`.slice(0, 4_000), updatedAt: new Date() })
          .where(eq(missionSteps.id, step.id));
        missionResults.push({ missionId: mission.id, stepId: step.id, outcome: 'retry-queued' });
      }
    }
  }

  return NextResponse.json({ ran: results.length, results, missions: missionResults });
}
