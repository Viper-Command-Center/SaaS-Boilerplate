/**
 * Mission tools (Phase 27) — the agent's interface to durable, multi-step work.
 *
 * Design (docs/MISSION_RUNNER_SPEC.md): the agent PLANS FIRST — start_mission
 * persists the decomposed plan; the cron runner (run-scheduled) executes one
 * step per tick through the same tool loop + approvals gateway as chat. The
 * plan living in Postgres instead of the model's head is the whole feature:
 * missions survive deploys, crashes, cleared chats and budget exhaustion.
 *
 * Kept OUT of platformTools.ts deliberately: same executor shape, merged by
 * the three toolset assemblers (chat, approvals-resume, run-scheduled), so
 * this file owns everything mission-shaped and platformTools stays untouched.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { missions, missionSteps } from '@/models/Schema';

type Executor = {
  policy: 'auto';
  call: (args: Record<string, unknown>) => Promise<string>;
};

export type MissionToolset = {
  anthropicTools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  executors: Map<string, Executor>;
};

const MAX_STEPS = 40;
const MAX_RESULT_CHARS = 4_000;

export function buildMissionTools(tenantId: string): MissionToolset {
  const anthropicTools: MissionToolset['anthropicTools'] = [
    {
      name: 'start_mission',
      description: 'Create a durable background mission for work too big for one turn (multi-hour builds, many-step campaigns). Decompose the goal into ordered steps FIRST — each step\'s instructions must be complete and standalone, because a separate scheduled run executes ONE step at a time with no memory of this chat. Size each step so it needs at most ~12 tool calls: a step like "write and commit 3 articles" is right, "write 20 articles" is wrong and will be cut off mid-work — split oversized work into more steps instead. The platform runs steps automatically every few minutes and pauses the mission for a human if a step fails twice. After calling this, tell the user the mission is running in the background and roughly when to expect progress.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short mission name, e.g. "Build 6-week growth sprint tracker".' },
          goal: { type: 'string', description: 'The user\'s ask, verbatim or near-verbatim.' },

          steps: {
            type: 'array',
            maxItems: MAX_STEPS,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                instructions: { type: 'string', description: 'Complete standalone instructions for this step — assume the executor has the workspace tools but NONE of this conversation.' },
              },
              required: ['title', 'instructions'],
            },
          },
        },
        required: ['title', 'goal', 'steps'],
      },
    },
    {
      name: 'update_mission_step',
      description: 'Checkpoint a mission step: mark it done/failed/skipped with a short result. Used by mission execution runs; in chat, use it when the user says a step is complete or should be skipped.',
      input_schema: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          status: { type: 'string', enum: ['done', 'failed', 'skipped'] },
          result: { type: 'string', description: 'Short outcome note (what was produced / why failed).' },
        },
        required: ['stepId', 'status'],
      },
    },
    {
      name: 'set_mission_status',
      description: 'Pause, resume or cancel a mission. pause = the runner stops picking up its steps (use when priorities change or a mission is misbehaving). resume = un-pause; any failed steps are re-queued with fresh attempts (use after the blocker is fixed). cancel = permanently close it — remaining steps are marked skipped and it will never run again (use for duplicates or wrong plans; there is no undo). ALWAYS prefer cancelling a wrong/duplicate mission over starting a competing one.',
      input_schema: {
        type: 'object',
        properties: {
          missionId: { type: 'string' },
          status: { type: 'string', enum: ['paused', 'running', 'cancelled'] },
          reason: { type: 'string', description: 'One line: why (recorded for the human).' },
        },
        required: ['missionId', 'status'],
      },
    },
    {
      name: 'list_missions',
      description: 'List this workspace\'s missions with status and step progress (done/total). Check here when the user asks about background work.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_mission',
      description: 'Full detail of one mission: goal, status, every step with its status and result. Use before continuing or reporting on a mission.',
      input_schema: {
        type: 'object',
        properties: { missionId: { type: 'string' } },
        required: ['missionId'],
      },
    },
  ];

  const executors = new Map<string, Executor>();

  executors.set('start_mission', {
    policy: 'auto',
    call: async (args) => {
      const title = String(args.title ?? '').slice(0, 200).trim();
      const goal = String(args.goal ?? '').slice(0, 4_000).trim();
      const rawSteps = Array.isArray(args.steps) ? args.steps.slice(0, MAX_STEPS) : [];
      if (!title || !goal || rawSteps.length === 0) {
        throw new Error('start_mission needs a title, the goal, and at least one step.');
      }
      // Pileup guard (Phase 28.2): the runner advances a few steps per tick
      // ACROSS ALL missions, so every extra concurrent mission slows the
      // others. Four "image" missions were once running at the same time
      // because launching a new one felt easier than cancelling the old one.
      const running = await db
        .select({ id: missions.id, title: missions.title })
        .from(missions)
        .where(and(eq(missions.tenantId, tenantId), eq(missions.status, 'running')))
        .limit(3);
      if (running.length >= 2) {
        throw new Error(`This workspace already has ${running.length} running missions (${running.map(m => `"${m.title}"`).join(', ')}). They share the background runner, so more missions = everything slower. Cancel or pause one with set_mission_status first (cancel duplicates — do not leave zombie missions running), or fold this work into an existing mission's remaining steps.`);
      }
      const [mission] = await db
        .insert(missions)
        .values({ tenantId, title, goal })
        .returning();
      if (!mission) {
        throw new Error('Could not create the mission.');
      }
      const rows = rawSteps.map((s, i) => ({
        missionId: mission.id,
        tenantId,
        position: i,
        title: String((s as Record<string, unknown>).title ?? `Step ${i + 1}`).slice(0, 200),
        instructions: String((s as Record<string, unknown>).instructions ?? '').slice(0, 8_000),
      }));
      await db.insert(missionSteps).values(rows);
      return `Mission "${title}" created (id ${mission.id}) with ${rows.length} steps. The platform will execute one step every few minutes; it pauses and notifies if a step fails twice. Tell the user it is running in the background.`;
    },
  });

  executors.set('update_mission_step', {
    policy: 'auto',
    call: async (args) => {
      const stepId = String(args.stepId ?? '');
      const status = String(args.status ?? '');
      if (!['done', 'failed', 'skipped'].includes(status)) {
        throw new Error('status must be done, failed or skipped.');
      }
      const [step] = await db
        .select()
        .from(missionSteps)
        .where(and(eq(missionSteps.tenantId, tenantId), eq(missionSteps.id, stepId)))
        .limit(1);
      if (!step) {
        throw new Error('No such step in this workspace.');
      }
      await db
        .update(missionSteps)
        .set({
          status,
          result: args.result !== undefined ? String(args.result).slice(0, MAX_RESULT_CHARS) : step.result,
          updatedAt: new Date(),
        })
        .where(eq(missionSteps.id, step.id));

      // Mission bookkeeping: all steps terminal → mission done.
      const remaining = await db
        .select({ id: missionSteps.id })
        .from(missionSteps)
        .where(and(
          eq(missionSteps.missionId, step.missionId),
          eq(missionSteps.status, 'pending'),
        ));
      const running = await db
        .select({ id: missionSteps.id })
        .from(missionSteps)
        .where(and(
          eq(missionSteps.missionId, step.missionId),
          eq(missionSteps.status, 'running'),
        ));
      if (remaining.length === 0 && running.length === 0) {
        await db
          .update(missions)
          .set({ status: 'done', updatedAt: new Date() })
          .where(eq(missions.id, step.missionId));
        return `Step "${step.title}" marked ${status}. All steps are now terminal — mission complete.`;
      }
      return `Step "${step.title}" marked ${status}. ${remaining.length} step(s) remaining.`;
    },
  });

  executors.set('set_mission_status', {
    policy: 'auto',
    call: async (args) => {
      const missionId = String(args.missionId ?? '');
      const requested = String(args.status ?? '');
      const reason = String(args.reason ?? '').slice(0, 300);
      if (!['paused', 'running', 'cancelled'].includes(requested)) {
        throw new Error('status must be paused, running or cancelled.');
      }
      const [m] = await db
        .select()
        .from(missions)
        .where(and(eq(missions.tenantId, tenantId), eq(missions.id, missionId)))
        .limit(1);
      if (!m) {
        throw new Error('No such mission in this workspace.');
      }
      if (m.status === 'done' || m.status === 'cancelled') {
        // Not an error when the request is a no-op: asking to cancel something
        // already cancelled has got the outcome it wanted.
        if (requested === 'cancelled') {
          return `Mission "${m.title}" was already ${m.status} — nothing to cancel.`;
        }
        throw new Error(`Mission "${m.title}" is already ${m.status} — it cannot be resumed. Start a new mission instead.`);
      }

      if (requested === 'cancelled') {
        // Terminal, honest bookkeeping: remaining steps become 'skipped' (not
        // deleted — the record of what was planned but never ran stays).
        await db
          .update(missionSteps)
          .set({ status: 'skipped', result: reason ? `Cancelled: ${reason}` : 'Cancelled', updatedAt: new Date() })
          .where(and(
            eq(missionSteps.missionId, m.id),
            inArray(missionSteps.status, ['pending', 'running']),
          ));
        await db
          .update(missions)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(missions.id, m.id));
        // 'cancelled', not 'done'. A cancelled mission and a completed one are
        // different facts, and recording both as 'done' meant nobody could tell
        // afterwards whether the work happened. It also made a second cancel
        // throw "already done — nothing to change", which reads like the cancel
        // failed rather than like it had already succeeded.
        return `Mission "${m.title}" cancelled — remaining steps marked skipped. It will not run again.`;
      }

      if (requested === 'running') {
        // Resuming means the human/agent believes the blocker is fixed —
        // failed steps get a fresh start (same rule as the human API).
        await db
          .update(missionSteps)
          .set({ status: 'pending', attempts: 0, updatedAt: new Date() })
          .where(and(eq(missionSteps.missionId, m.id), eq(missionSteps.status, 'failed')));
      }
      await db
        .update(missions)
        .set({ status: requested, updatedAt: new Date() })
        .where(eq(missions.id, m.id));
      return requested === 'paused'
        ? `Mission "${m.title}" paused — the runner will not pick up further steps until it is resumed.`
        : `Mission "${m.title}" resumed — failed steps (if any) re-queued with fresh attempts.`;
    },
  });

  executors.set('list_missions', {
    policy: 'auto',
    call: async () => {
      const rows = await db
        .select()
        .from(missions)
        .where(eq(missions.tenantId, tenantId))
        .orderBy(desc(missions.updatedAt))
        .limit(20);
      if (rows.length === 0) {
        return 'No missions in this workspace yet.';
      }
      const lines = await Promise.all(rows.map(async (m) => {
        const steps = await db
          .select({ status: missionSteps.status })
          .from(missionSteps)
          .where(eq(missionSteps.missionId, m.id));
        const done = steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
        return `- ${m.title} [${m.status}] ${done}/${steps.length} steps (id ${m.id})`;
      }));
      return lines.join('\n');
    },
  });

  executors.set('get_mission', {
    policy: 'auto',
    call: async (args) => {
      const missionId = String(args.missionId ?? '');
      const [m] = await db
        .select()
        .from(missions)
        .where(and(eq(missions.tenantId, tenantId), eq(missions.id, missionId)))
        .limit(1);
      if (!m) {
        throw new Error('No such mission in this workspace.');
      }
      const steps = await db
        .select()
        .from(missionSteps)
        .where(eq(missionSteps.missionId, m.id))
        .orderBy(asc(missionSteps.position));
      return [
        `Mission: ${m.title} [${m.status}]`,
        `Goal: ${m.goal}`,
        ...steps.map(s => `${s.position + 1}. [${s.status}${s.attempts > 0 ? `, attempts ${s.attempts}` : ''}] ${s.title}${s.result ? ` — ${s.result.slice(0, 400)}` : ''}`),
      ].join('\n');
    },
  });

  return { anthropicTools, executors };
}
