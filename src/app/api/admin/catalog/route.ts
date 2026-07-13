/**
 * Plugin catalog — platform admin CRUD.
 *
 * GET    /api/admin/catalog       — entries + available built-in providers
 * POST   /api/admin/catalog       — create (tier1 credential sealed into vault)
 * PATCH  /api/admin/catalog       — update (enable/disable, price rules, url…)
 * DELETE /api/admin/catalog?id=   — remove
 *
 * tier1 = platform-provided: OUR key, metered + billed via priceRules.
 *   · transport 'builtin' → in-app adapter (Kie.ai…), pick a provider
 *   · transport 'http'    → a hosted MCP server we pay for (e.g. our DataForSEO)
 * tier2 = bring-your-own-key: the client pastes their own credential.
 */

import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { listBuiltinProviders } from '@/libs/plugins';
import { sealSecret, vaultConfigured } from '@/libs/vault';
import { credentials, pluginCatalog } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const PriceRuleSchema = z.object({
  unit: z.enum(['call', 'arg']),
  argField: z.string().max(60).optional(),
  costUsd: z.number().min(0),
  markup: z.number().min(1).max(20).optional(),
});

const CreateSchema = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes only'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: z.string().max(40).optional(),
  tier: z.enum(['tier1', 'tier2']),
  transport: z.enum(['http', 'builtin']).default('http'),
  provider: z.string().max(60).optional(), // builtin only
  url: z.string().url().max(2000).optional(), // http only
  authHeader: z.string().max(80).optional(),
  authHint: z.string().max(200).optional(),
  credentialValue: z.string().max(4000).optional(), // tier1 only
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
      transport: pluginCatalog.transport,
      provider: pluginCatalog.provider,
      url: pluginCatalog.url,
      authHeader: pluginCatalog.authHeader,
      authHint: pluginCatalog.authHint,
      priceRules: pluginCatalog.priceRules,
      enabled: pluginCatalog.enabled,
      credentialId: pluginCatalog.credentialId,
    })
    .from(pluginCatalog)
    .orderBy(desc(pluginCatalog.createdAt));

  return NextResponse.json({
    catalog: rows.map(r => ({ ...r, hasCredential: Boolean(r.credentialId), credentialId: undefined })),
    builtinProviders: listBuiltinProviders(),
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

  if (body.transport === 'http' && !body.url) {
    return NextResponse.json({ error: 'An MCP server URL is required.' }, { status: 400 });
  }
  if (body.transport === 'builtin' && !body.provider) {
    return NextResponse.json({ error: 'Pick a built-in provider.' }, { status: 400 });
  }

  const existing = await db.select({ id: pluginCatalog.id }).from(pluginCatalog).where(eq(pluginCatalog.slug, body.slug)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'A plugin with this slug already exists.' }, { status: 409 });
  }

  // Tier 1 holds OUR credential — sealed in the vault (tenantId NULL =
  // platform-level, shared by every workspace that enables the plugin).
  let credentialId: string | undefined;
  if (body.tier === 'tier1') {
    if (!body.credentialValue) {
      return NextResponse.json({ error: 'Tier 1 plugins need the platform credential (your API key).' }, { status: 400 });
    }
    if (!vaultConfigured()) {
      return NextResponse.json({ error: 'VAULT_MASTER_KEY is not configured.' }, { status: 500 });
    }
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
      transport: body.transport,
      provider: body.transport === 'builtin' ? body.provider : null,
      url: body.transport === 'http' ? body.url : null,
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
  let body: {
    id?: string;
    enabled?: boolean;
    priceRules?: unknown;
    url?: string;
    description?: string;
    credentialValue?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: 'id required.' }, { status: 400 });
  }

  // Rotating the platform key
  if (body.credentialValue) {
    const [entry] = await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, body.id)).limit(1);
    if (entry?.credentialId) {
      await db
        .update(credentials)
        .set({ cipher: sealSecret(body.credentialValue) })
        .where(eq(credentials.id, entry.credentialId));
    }
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
