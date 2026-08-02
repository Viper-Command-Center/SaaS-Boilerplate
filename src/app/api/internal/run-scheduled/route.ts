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
 */

import { and, asc, eq, lte } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { runToolLoop } from '@/libs/agent/loop';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { buildSystemPrompt } from '@/libs/agent/prompt';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { scheduledTasks, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_TASKS_PER_TICK = 3;
const MISSION_MAX_ITERATIONS = 40;
const MISSION_WALL_CLOCK_MS = 4 * 60_000; // leave headroom under maxDuration
const CONTINUATION_DELAY_MS = 5 * 60_000;

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || request.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const due = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, new Date())))
    .orderBy(asc(scheduledTasks.nextRunAt))
    .limit(MAX_TASKS_PER_TICK);

  const results: Array<{ id: string; name: string; ok: boolean; continued?: boolean }> = [];

  for (const task of due) {
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

      let mcpToolset: Awaited<ReturnType<typeof buildTenantToolset>>;
      try {
        mcpToolset = await buildTenantToolset(tenant.id);
      } catch {
        mcpToolset = { anthropicTools: [], failedConnections: [], resolve: () => null };
      }
      const platform = buildPlatformTools(tenant.id);
      const toolset = {
        anthropicTools: [...platform.anthropicTools, ...mcpToolset.anthropicTools],
        failedConnections: mcpToolset.failedConnections,
        resolve: (name: string) => {
          const p = platform.executors.get(name);
          if (p) {
            return { connectionId: '', connectionName: 'platform', toolName: name, policy: p.policy, call: p.call };
          }
          return mcpToolset.resolve(name);
        },
      };

      // Same employee runs the 3am mission as runs the chat.
      const agent = await resolveAgentForTenant(tenant.id);
      const system = `${buildSystemPrompt({ tenant: { ...tenant, role: 'owner' }, agent })}

This is an AUTOMATED SCHEDULED RUN of your standing task "${task.name}" — no
human is watching live. Do the work now with your tools. Anything requiring
approval will queue in the Approvals inbox. Keep the final summary short; it
is stored as the run's result. If useful, record progress via write_dataset.
If your tool budget runs out mid-task, summarise honestly what remains — the
platform will requeue you within minutes to continue from that summary.`;

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

  return NextResponse.json({ ran: results.length, results });
}
