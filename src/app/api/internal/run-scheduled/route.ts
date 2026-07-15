/**
 * POST /api/internal/run-scheduled — cron entrypoint for scheduled agent
 * tasks. Protected by the CRON_SECRET env var (header `x-cron-secret`).
 * Triggered by the repo's GitHub Actions workflow (or any external cron).
 *
 * Executes up to 3 due tasks per invocation through the same tool loop +
 * approvals gateway as chat. Each run is stateless: the task's stored prompt
 * is the complete instruction set.
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

  const results: Array<{ id: string; name: string; ok: boolean }> = [];

  for (const task of due) {
    // Claim immediately so overlapping cron ticks don't double-run it.
    await db
      .update(scheduledTasks)
      .set({ nextRunAt: new Date(Date.now() + task.intervalMinutes * 60_000), lastRunAt: new Date() })
      .where(eq(scheduledTasks.id, task.id));

    let output = '';
    let ok = true;
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
is stored as the run's result. If useful, record progress via write_dataset.`;

      output = await runToolLoop({
        tenantId: tenant.id,
        conversationId: '',
        system,
        history: [],
        userText: task.prompt,
        toolset,
        onDelta: () => {},
      });
    } catch (err) {
      ok = false;
      output = `Run failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    }

    await db
      .update(scheduledTasks)
      .set({ lastResult: output.slice(0, 4000) })
      .where(eq(scheduledTasks.id, task.id));
    results.push({ id: task.id, name: task.name, ok });
  }

  return NextResponse.json({ ran: results.length, results });
}
