/**
 * /api/missions?tenant=<slug> — the HUMAN control surface for durable
 * missions (Phase 27, docs/MISSION_RUNNER_SPEC.md). The agent's controls are
 * the mission tools (start_mission etc.); this is the pairing rule from
 * Phase 21/24: every mechanism wired to the agent gets a control wired to the
 * human in the same change.
 *
 * GET  → missions with step summaries + runner health (any member — read-only
 *   view). lastTickAt is the in-memory runner heartbeat (Phase 29): the panel
 *   turns it into "runner ticked Xm ago" vs "no tick in Xm — check GitHub
 *   Actions" so a silently-dead cron reads as a platform problem, not a stuck
 *   mission.
 * PATCH {id, action: 'pause' | 'resume' | 'cancel'} → editor+.
 *   pause  — stop the runner picking up further steps (running → paused).
 *   resume — un-pause (paused → running). Resuming a mission whose step
 *   FAILED twice re-queues that step (failed → pending, attempts reset) so
 *   the human can fix the underlying problem (bad key, missing approval) and
 *   simply hit resume.
 *   cancel — permanently close a mission (any live state → done); remaining
 *   pending/running steps become 'skipped' with a "Cancelled from dashboard"
 *   result. Mirrors the agent's set_mission_status cancel; there is no undo.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { RESUME_PRIORITY_AT } from '@/libs/agent/missionTools';
import { getLastTickAt } from '@/libs/agent/runnerHealth';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { missions, missionSteps } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const EDITOR_ROLES = ['owner', 'admin', 'editor'];

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }

  const rows = await db
    .select()
    .from(missions)
    .where(eq(missions.tenantId, tenant.id))
    .orderBy(desc(missions.updatedAt))
    .limit(50);

  const result = await Promise.all(rows.map(async (m) => {
    const steps = await db
      .select({
        id: missionSteps.id,
        position: missionSteps.position,
        title: missionSteps.title,
        status: missionSteps.status,
        result: missionSteps.result,
        attempts: missionSteps.attempts,
        updatedAt: missionSteps.updatedAt,
      })
      .from(missionSteps)
      .where(eq(missionSteps.missionId, m.id))
      .orderBy(asc(missionSteps.position));
    return {
      id: m.id,
      title: m.title,
      goal: m.goal,
      status: m.status,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      steps: steps.map(s => ({ ...s, result: s.result ? s.result.slice(0, 600) : null })),
    };
  }));

  return NextResponse.json({ missions: result, lastTickAt: getLastTickAt() });
}

const ActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['pause', 'resume', 'cancel']),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Role check BEFORE reading the body (the upload-403 lesson).
  const slug = new URL(request.url).searchParams.get('tenant') ?? '';
  const tenant = (await getUserTenants(user.id)).find(t => t.slug === slug);
  if (!tenant) {
    return NextResponse.json({ error: 'No access to this workspace.' }, { status: 403 });
  }
  if (!user.isAdmin && !EDITOR_ROLES.includes(tenant.role)) {
    return NextResponse.json({ error: 'You need editor access to control missions.' }, { status: 403 });
  }

  let body: z.infer<typeof ActionSchema>;
  try {
    body = ActionSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Re-scope by tenant — the client sends an id, never trust it alone.
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.tenantId, tenant.id), eq(missions.id, body.id)))
    .limit(1);
  if (!mission) {
    return NextResponse.json({ error: 'Mission not found.' }, { status: 404 });
  }

  if (body.action === 'pause') {
    if (mission.status !== 'running' && mission.status !== 'waiting_approval') {
      return NextResponse.json({ error: `Cannot pause a ${mission.status} mission.` }, { status: 400 });
    }
    await db
      .update(missions)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(missions.id, mission.id));
    return NextResponse.json({ ok: true, status: 'paused' });
  }

  if (body.action === 'cancel') {
    // Same terminal bookkeeping as the agent's set_mission_status cancel:
    // remaining pending/running steps become 'skipped' (the record of what
    // was planned but never ran stays), and the mission closes to 'done'. No
    // undo — a zombie mission the human explicitly killed should never run
    // another step.
    if (mission.status === 'done') {
      return NextResponse.json({ error: 'Mission is already done.' }, { status: 400 });
    }
    await db
      .update(missionSteps)
      .set({ status: 'skipped', result: 'Cancelled from dashboard', updatedAt: new Date() })
      .where(and(
        eq(missionSteps.missionId, mission.id),
        inArray(missionSteps.status, ['pending', 'running']),
      ));
    await db
      .update(missions)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(missions.id, mission.id));
    return NextResponse.json({ ok: true, status: 'done' });
  }

  // resume
  if (mission.status !== 'paused') {
    return NextResponse.json({ error: `Cannot resume a ${mission.status} mission.` }, { status: 400 });
  }
  // A mission usually pauses BECAUSE a step failed twice. Resuming means the
  // human believes the blocker is fixed — give that step a fresh start.
  await db
    .update(missionSteps)
    .set({ status: 'pending', attempts: 0, updatedAt: new Date() })
    .where(and(eq(missionSteps.missionId, mission.id), eq(missionSteps.status, 'failed')));
  await db
    .update(missions)
    // Backdated on purpose: the runner sorts by updatedAt ASC, so `now` would
    // queue a resumed mission LAST. See RESUME_PRIORITY_AT in missionTools.
    .set({ status: 'running', updatedAt: RESUME_PRIORITY_AT })
    .where(eq(missions.id, mission.id));
  return NextResponse.json({ ok: true, status: 'running' });
}
