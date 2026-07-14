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

import { desc, eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { CATALOG_PRESETS, getBuiltinProvider, listBuiltinProviders } from '@/libs/plugins';
import { MAX_KEYS, parseKeys } from '@/libs/plugins/kie';
import { openSecret, sealSecret, vaultConfigured } from '@/libs/vault';
import { credentials, pluginCatalog } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const PriceRuleSchema = z.object({
  // 'usage' = the provider reports units it consumed (e.g. Kie credits).
  unit: z.enum(['call', 'arg', 'usage']),
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

/**
 * Multi-key providers (Kie.ai) accept up to 20 keys, one per line — the adapter
 * round-robins and fails over. Everything else takes exactly one credential.
 */
function validateKeys(value: string, multiKey: boolean): string | null {
  const count = parseKeys(value).length;
  if (count === 0) {
    return 'The credential is empty.';
  }
  if (!multiKey && count > 1) {
    return 'This plugin takes a single credential.';
  }
  if (count > MAX_KEYS) {
    return `Up to ${MAX_KEYS} keys, one per line.`;
  }
  return null;
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

  // How many keys are stored (multi-key providers like Kie.ai) — the VALUES are
  // never returned, only the count, so the admin can see "4 keys in rotation".
  const credIds = rows.map(r => r.credentialId).filter((v): v is string => Boolean(v));
  const keyCounts = new Map<string, number>();
  if (credIds.length > 0) {
    const creds = await db
      .select({ id: credentials.id, cipher: credentials.cipher })
      .from(credentials)
      .where(inArray(credentials.id, credIds));
    for (const c of creds) {
      try {
        keyCounts.set(c.id, parseKeys(openSecret(c.cipher)).length);
      } catch {
        keyCounts.set(c.id, 0);
      }
    }
  }

  return NextResponse.json({
    catalog: rows.map(r => ({
      ...r,
      hasCredential: Boolean(r.credentialId),
      keyCount: r.credentialId ? (keyCounts.get(r.credentialId) ?? 0) : 0,
      credentialId: undefined,
    })),
    builtinProviders: listBuiltinProviders(),
    presets: CATALOG_PRESETS,
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

  // Per-connection providers (WordPress) never have a platform key — each
  // workspace supplies its own site + credential when they enable it.
  const bp = body.transport === 'builtin' && body.provider ? getBuiltinProvider(body.provider) : undefined;
  const perConnection = Boolean(bp?.perConnection);

  // Tier 1 holds OUR credential — sealed in the vault (tenantId NULL =
  // platform-level, shared by every workspace that enables the plugin).
  let credentialId: string | undefined;
  if (body.tier === 'tier1' && !perConnection) {
    if (!body.credentialValue) {
      return NextResponse.json({ error: 'Tier 1 plugins need the platform credential (your API key).' }, { status: 400 });
    }
    const keyErr = validateKeys(body.credentialValue, Boolean(bp?.multiKey));
    if (keyErr) {
      return NextResponse.json({ error: keyErr }, { status: 400 });
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

/**
 * Full edit. Every field of a catalog entry can be corrected after the fact
 * (a mis-typed name, the wrong tier, a bad price table, the wrong key) —
 * except the slug, which workspace connections point at.
 */
const UpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(40).optional(),
  tier: z.enum(['tier1', 'tier2']).optional(),
  transport: z.enum(['http', 'builtin']).optional(),
  provider: z.string().max(60).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  authHeader: z.string().max(80).nullable().optional(),
  authHint: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  priceRules: z.record(z.string(), PriceRuleSchema).optional(),
  /** Rotate (or set for the first time) the platform credential. */
  credentialValue: z.string().max(4000).optional(),
});

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  let body: z.infer<typeof UpdateSchema>;
  try {
    body = UpdateSchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Invalid request.';
    return NextResponse.json({ error: msg ?? 'Invalid request.' }, { status: 400 });
  }

  const [entry] = await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, body.id)).limit(1);
  if (!entry) {
    return NextResponse.json({ error: 'Plugin not found.' }, { status: 404 });
  }

  const transport = body.transport ?? entry.transport;
  const tier = body.tier ?? entry.tier;
  const url = body.url !== undefined ? body.url : entry.url;
  const provider = body.provider !== undefined ? body.provider : entry.provider;

  if (transport === 'http' && !url) {
    return NextResponse.json({ error: 'An MCP server URL is required.' }, { status: 400 });
  }
  if (transport === 'builtin' && !provider) {
    return NextResponse.json({ error: 'Pick a built-in provider.' }, { status: 400 });
  }

  // Credential: rotate the existing one, or create the platform credential if
  // the entry didn't have one (e.g. it was tier2 and is now tier1).
  let credentialId = entry.credentialId;
  if (body.credentialValue) {
    const bp = transport === 'builtin' && provider ? getBuiltinProvider(provider) : undefined;
    const keyErr = validateKeys(body.credentialValue, Boolean(bp?.multiKey));
    if (keyErr) {
      return NextResponse.json({ error: keyErr }, { status: 400 });
    }
    if (!vaultConfigured()) {
      return NextResponse.json({ error: 'VAULT_MASTER_KEY is not configured.' }, { status: 500 });
    }
    if (credentialId) {
      await db
        .update(credentials)
        .set({ cipher: sealSecret(body.credentialValue) })
        .where(eq(credentials.id, credentialId));
    } else {
      const [cred] = await db
        .insert(credentials)
        .values({
          tenantId: null,
          provider: entry.slug,
          label: `platform · ${entry.slug}`,
          cipher: sealSecret(body.credentialValue),
        })
        .returning({ id: credentials.id });
      credentialId = cred?.id ?? null;
    }
  }

  await db
    .update(pluginCatalog)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.authHeader !== undefined ? { authHeader: body.authHeader } : {}),
      ...(body.authHint !== undefined ? { authHint: body.authHint } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.priceRules !== undefined ? { priceRules: body.priceRules } : {}),
      tier,
      transport,
      // Keep the two transports mutually exclusive so the registry never has
      // to guess which one an entry meant.
      provider: transport === 'builtin' ? provider : null,
      url: transport === 'http' ? url : null,
      credentialId,
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
