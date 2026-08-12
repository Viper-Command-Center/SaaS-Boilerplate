/**
 * AI Employees — creating and editing the personas themselves. Platform admin
 * only.
 *
 * The gallery and the per-workspace assignment already lived in
 * /api/personas. What was missing was any way to ADD one: nothing in the
 * application ever wrote to agent_personas, so every employee had to be
 * inserted by hand in SQL. That is fine once and untenable at 350 client
 * sites — and it meant the one part of the product a client sees first, the
 * name and face of their agent, was the part only an engineer could change.
 *
 * GET    /api/admin/personas  — every persona, including disabled ones
 * POST   /api/admin/personas  — create
 * PATCH  /api/admin/personas  — edit, enable, disable
 *
 * There is no DELETE. A persona may be assigned to a workspace, and deleting
 * it would leave that workspace's agent silently reverting to "Agent" with no
 * explanation to the client looking at it. Disabling removes it from the
 * picker while leaving existing assignments intact, which is what "retire an
 * employee" actually means.
 */

import { asc, eq, isNotNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { personaSlug } from '@/libs/agent/personaSlug';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { agentPersonas, auditLog, tenants } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const ACCENTS = ['indigo', 'violet', 'fuchsia', 'emerald', 'amber', 'rose', 'sky', 'slate'] as const;

async function requireAdmin() {
  const user = await getCurrentUser();
  return user?.isAdmin ? user : null;
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  const rows = await db.select().from(agentPersonas).orderBy(asc(agentPersonas.name));

  /**
   * Which workspaces each persona currently works.
   *
   * Without this, disabling an employee is a decision made blind — the admin
   * cannot see that Noah is the face three clients have been talking to all
   * month.
   */
  const assigned = await db
    .select({ personaId: tenants.personaId, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(isNotNull(tenants.personaId));

  const byPersona = new Map<string, Array<{ name: string; slug: string }>>();
  for (const row of assigned) {
    if (!row.personaId) {
      continue;
    }
    const list = byPersona.get(row.personaId) ?? [];
    list.push({ name: row.name, slug: row.slug });
    byPersona.set(row.personaId, list);
  }

  return NextResponse.json({
    personas: rows.map(p => ({ ...p, workspaces: byPersona.get(p.id) ?? [] })),
    accents: ACCENTS,
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(60),
  tagline: z.string().max(160).optional(),
  role: z.string().max(60).optional(),
  personality: z.string().min(20).max(4000),
  avatarUrl: z.string().max(2000).optional(),
  accent: z.enum(ACCENTS).optional(),
});

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: 'A name, and a personality of at least 20 characters, are required.' },
      { status: 400 },
    );
  }

  const slug = personaSlug(body.name);
  if (!slug) {
    return NextResponse.json(
      { error: 'That name has no letters or numbers in it, so it cannot be turned into an identifier.' },
      { status: 400 },
    );
  }

  const existing = await db
    .select({ id: agentPersonas.id, name: agentPersonas.name })
    .from(agentPersonas)
    .where(eq(agentPersonas.slug, slug))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      {
        error: `An employee called "${existing[0]?.name}" already uses the identifier "${slug}". Pick a different name.`,
      },
      { status: 409 },
    );
  }

  const [persona] = await db
    .insert(agentPersonas)
    .values({
      slug,
      name: body.name.trim(),
      tagline: body.tagline?.trim() || null,
      role: body.role?.trim() || null,
      personality: body.personality.trim(),
      avatarUrl: body.avatarUrl?.trim() || null,
      accent: body.accent ?? 'indigo',
    })
    .returning();

  await db.insert(auditLog).values({
    tenantId: null,
    actor: admin.id,
    action: 'persona.create',
    target: slug,
  }).catch(() => {});

  return NextResponse.json({ ok: true, persona });
}

const UpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60).optional(),
  tagline: z.string().max(160).nullable().optional(),
  role: z.string().max(60).nullable().optional(),
  personality: z.string().min(20).max(4000).optional(),
  avatarUrl: z.string().max(2000).nullable().optional(),
  accent: z.enum(ACCENTS).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof UpdateSchema>;
  try {
    body = UpdateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { id, ...fields } = body;

  /**
   * The slug deliberately does NOT follow a rename. Workspaces reference a
   * persona by id, so renaming is safe for them — but a seed or an import
   * matches on slug, and changing it would create a second copy on the next
   * run instead of updating this one. Renaming "Noah" to "Noah B." should
   * change what clients see, not fork the record.
   */
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    patch.name = fields.name.trim();
  }
  if (fields.tagline !== undefined) {
    patch.tagline = fields.tagline?.trim() || null;
  }
  if (fields.role !== undefined) {
    patch.role = fields.role?.trim() || null;
  }
  if (fields.personality !== undefined) {
    patch.personality = fields.personality.trim();
  }
  if (fields.avatarUrl !== undefined) {
    patch.avatarUrl = fields.avatarUrl?.trim() || null;
  }
  if (fields.accent !== undefined) {
    patch.accent = fields.accent;
  }
  if (fields.enabled !== undefined) {
    patch.enabled = fields.enabled;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });
  }

  const [persona] = await db
    .update(agentPersonas)
    .set(patch)
    .where(eq(agentPersonas.id, id))
    .returning();

  if (!persona) {
    return NextResponse.json({ error: 'No such employee.' }, { status: 404 });
  }

  await db.insert(auditLog).values({
    tenantId: null,
    actor: admin.id,
    action: 'persona.update',
    target: persona.slug,
    detail: { fields: Object.keys(patch) },
  }).catch(() => {});

  return NextResponse.json({ ok: true, persona });
}
