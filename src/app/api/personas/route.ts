/**
 * AI Employees.
 *
 * GET   /api/personas?tenant=<slug>  — the gallery + who currently works this
 *                                      workspace (any member can see it)
 * PATCH /api/personas                — assign an employee to the workspace
 *                                      { tenantSlug, personaId|null, agentName? }
 *                                      (owner/admin, or platform admin)
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listPersonas, resolveAgentForTenant } from '@/libs/agent/persona';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { agentPersonas, auditLog, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = ['owner', 'admin'];

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

  const [gallery, current] = await Promise.all([
    listPersonas(),
    resolveAgentForTenant(tenant.id),
  ]);

  return NextResponse.json({
    personas: gallery,
    current: {
      name: current.name,
      avatarUrl: current.avatarUrl,
      accent: current.accent,
      personaId: current.persona?.id ?? null,
    },
    canManage: user.isAdmin || MANAGER_ROLES.includes(tenant.role),
  });
}

const AssignSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  personaId: z.string().uuid().nullable(),
  // Optional rename ("Bud" → "Buddy") without forking the persona.
  agentName: z.string().max(60).nullable().optional(),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof AssignSchema>;
  try {
    body = AssignSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const tenant = (await getUserTenants(user.id)).find(t => t.slug === body.tenantSlug);
  if (!tenant || (!user.isAdmin && !MANAGER_ROLES.includes(tenant.role))) {
    return NextResponse.json({ error: 'You need owner/admin access to change the AI employee.' }, { status: 403 });
  }

  // Verify the persona exists and is enabled before assigning it.
  if (body.personaId) {
    const [p] = await db
      .select({ id: agentPersonas.id, enabled: agentPersonas.enabled })
      .from(agentPersonas)
      .where(eq(agentPersonas.id, body.personaId))
      .limit(1);
    if (!p || !p.enabled) {
      return NextResponse.json({ error: 'That AI employee is not available.' }, { status: 404 });
    }
  }

  await db
    .update(tenants)
    .set({
      personaId: body.personaId,
      ...(body.agentName !== undefined ? { agentNameOverride: body.agentName || null } : {}),
    })
    .where(eq(tenants.id, tenant.id));

  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'persona.assign',
    target: body.personaId ?? 'none',
  }).catch(() => {});

  const current = await resolveAgentForTenant(tenant.id);
  return NextResponse.json({ ok: true, current: { name: current.name, avatarUrl: current.avatarUrl, accent: current.accent } });
}
