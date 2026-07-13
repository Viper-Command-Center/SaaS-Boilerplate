/**
 * Plugin catalog — platform admin CRUD.
 *
 * GET    /api/admin/catalog       — list entries
 * POST   /api/admin/catalog       — create (tier1 credential is sealed into the vault)
 * PATCH  /api/admin/catalog       — update (enable/disable, price rules, url…)
 * DELETE /api/admin/catalog?id=   — remove
 *
 * tier1 = platform-provided (our key, metered + billed via priceRules)
 * tier2 = bring-your-own-key (client pastes their credential when enabling)
 */

import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { sealSecret, vaultConfigured } from '@/libs/vault';
import { credentials, pluginCatalog } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const PriceRuleSchema = z.object({
  unit: z.enum(['call', 'arg']),
  argField: z.string().max(60).optional(),
  costUsd: z.number().min(0),
  markup: z.number().min(1).optional(),
});

const CreateSchema = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes only'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: z.string().max(40).optional(),
  tier: z.enum(['tier1', 'tier2']),
  url: z.string().url().max(2000),
  authHeader: z.string().max(80).optional(),
  authHint: z.string().max(200).optional(),
  /** tier1 only: the platform's own credential value — sealed, never returned. */
  credentialValue: z.string().max(4000).optional(),
  /** tier1 only: { toolName: { unit, costUsd, argField?, markup? } } */
  priceRules: z.record(z.string(), PriceRuleSchema).optional(),
});

async function requireAdmin() {
  const user = await getCurrentUser();
  return user?.isAdmin ? user : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const rows = await db
    .select({
      id: pluginCatalog.id,
      slug: pluginCatalog.slug,
      name: pluginCatalog.name,
      description: pluginCatalog.description,
      category: pluginCatalog.category,
      tier: pluginCatalog.tier,
      url: pluginCatalog.url,
      authHeader: pluginCatalog.authHeader,
      authHint: pluginCatalog.authHint,
      priceRules: pluginCatalog.priceRules,
      enabled: pluginCatalog.enabled,
      hasCredential: pluginCatalog.credentialId,
    })
    .from(pluginCatalog)
    .orderBy(desc(pluginCatalog.createdAt));

  return NextResponse.json({
    catalog: rows.map(r => ({ ...r, hasCredential: Boolean(r.hasCredential) })),
    vaultConfigured: vaultConfigured(),
  });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Invalid request.';
    return NextResponse.json({ error: msg ?? 'Invalid request.' }, { status: 400 });
  }

  const existing = await db.select({ id: pluginCatalog.id }).from(pluginCatalog).where(eq(pluginCatalog.slug, body.slug)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'A plugin with this slug already exists.' }, { status: 409 });
  }

  // Tier 1 holds OUR credential — sealed in the vault, reused for every
  // workspace that enables the plugin, and metered via priceRules.
  let credentialId: string | undefined;
  if (body.tier === 'tier1') {
    if (!body.credentialValue) {
      return NextResponse.json({ error: 'Tier 1 plugins need the platform credential value.' }, { status: 400 });
    }
    if (!vaultConfigured()) {
      return NextResponse.json({ error: 'VAULT_MASTER_KEY is not configured.' }, { status: 500 });
    }
    // Platform-level credential: tenantId NULL means "owned by the platform,
    // shared by every workspace that enables this plugin".
    const [cred] = await db
      .insert(credentials)
      .values({
        tenantId: null,
        provider: body.slug,
        label: `platform · ${body.slug}`,
        cipher: sealSecret(body.credentialValue),
      })
      .returning({ id: credentials.id });
    credentialId = cred?.id;
  }

  const [row] = await db
    .insert(pluginCatalog)
    .values({
      slug: body.slug,
      name: body.name,
      description: body.description,
      category: body.category,
      tier: body.tier,
      transport: 'http',
      url: body.url,
      authHeader: body.authHeader,
      authHint: body.authHint,
      credentialId,
      priceRules: body.priceRules ?? {},
    })
    .returning({ id: pluginCatalog.id, slug: pluginCatalog.slug });

  return NextResponse.json({ ok: true, plugin: row });
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  let body: { id?: string; enabled?: boolean; priceRules?: unknown; url?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: 'id required.' }, { status: 400 });
  }

  await db
    .update(pluginCatalog)
    .set({
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.priceRules !== undefined ? { priceRules: body.priceRules } : {}),
      ...(body.url !== undefined ? { url: String(body.url) } : {}),
      ...(body.description !== undefined ? { description: String(body.description) } : {}),
    })
    .where(eq(pluginCatalog.id, body.id));

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!id) {
    return NextResponse.json({ error: 'id required.' }, { status: 400 });
  }
  await db.delete(pluginCatalog).where(eq(pluginCatalog.id, id));
  return NextResponse.json({ ok: true });
}
