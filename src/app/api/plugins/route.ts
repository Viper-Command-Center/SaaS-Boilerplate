/**
 * The workspace-facing plugin marketplace.
 *
 * GET  /api/plugins?tenant=<slug>  — catalog entries + whether this workspace
 *                                    has each enabled
 * POST /api/plugins                — enable one for this workspace
 *      tier1: uses the platform credential (nothing for the client to paste)
 *      tier2: the client supplies their own key, sealed into their vault
 * Owners/admins only.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { sealSecret, vaultConfigured } from '@/libs/vault';
import { auditLog, credentials, mcpConnections, pluginCatalog } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = ['owner', 'admin'];

async function requireManaged(userId: string, isAdmin: boolean, slug: string) {
  const tenant = (await getUserTenants(userId)).find(t => t.slug === slug);
  if (!tenant || (!isAdmin && !MANAGER_ROLES.includes(tenant.role))) {
    return null;
  }
  return tenant;
}

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

  const catalog = await db
    .select()
    .from(pluginCatalog)
    .where(eq(pluginCatalog.enabled, true));

  const installed = await db
    .select({ catalogId: mcpConnections.catalogId, enabled: mcpConnections.enabled })
    .from(mcpConnections)
    .where(eq(mcpConnections.tenantId, tenant.id));
  const installedIds = new Set(installed.map(i => i.catalogId).filter(Boolean));

  return NextResponse.json({
    plugins: catalog.map((p) => {
      const rules = (p.priceRules ?? {}) as Record<string, { unit: string; costUsd: number; markup?: number; argField?: string }>;
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        category: p.category,
        tier: p.tier,
        authHint: p.authHint,
        needsKey: p.tier === 'tier2',
        installed: installedIds.has(p.id),
        // Show clients what they'll be charged, never our raw cost.
        pricing: Object.entries(rules).map(([tool, r]) => ({
          tool,
          unit: r.unit === 'arg' ? (r.argField ?? 'unit') : 'call',
          retailUsd: Number((r.costUsd * (r.markup ?? 1.5)).toFixed(4)),
        })),
      };
    }),
  });
}

const EnableSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  pluginId: z.string().uuid(),
  /** tier2 only: the client's own API key. */
  credentialValue: z.string().max(4000).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof EnableSchema>;
  try {
    body = EnableSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const tenant = await requireManaged(user.id, user.isAdmin, body.tenantSlug);
  if (!tenant) {
    return NextResponse.json({ error: 'You need owner/admin access to add tools.' }, { status: 403 });
  }

  const [plugin] = await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, body.pluginId)).limit(1);
  if (!plugin || !plugin.enabled) {
    return NextResponse.json({ error: 'Plugin not available.' }, { status: 404 });
  }

  const already = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.tenantId, tenant.id), eq(mcpConnections.catalogId, plugin.id)))
    .limit(1);
  if (already.length > 0) {
    return NextResponse.json({ error: 'Already enabled in this workspace.' }, { status: 409 });
  }

  // Tier 2 → seal the client's own key. Tier 1 → the platform credential on
  // the catalog entry is used at call time; nothing is stored per workspace.
  const headerCredentials: Record<string, string> = {};
  if (plugin.tier === 'tier2') {
    if (!body.credentialValue) {
      return NextResponse.json({ error: 'This plugin needs your API key.' }, { status: 400 });
    }
    if (!vaultConfigured()) {
      return NextResponse.json({ error: 'Credential vault is not configured.' }, { status: 500 });
    }
    const [cred] = await db
      .insert(credentials)
      .values({
        tenantId: tenant.id,
        provider: plugin.slug,
        label: `${plugin.slug} · ${plugin.authHeader ?? 'Authorization'}`,
        cipher: sealSecret(body.credentialValue),
      })
      .returning({ id: credentials.id });
    if (cred) {
      headerCredentials[plugin.authHeader ?? 'Authorization'] = cred.id;
    }
  }

  await db.insert(mcpConnections).values({
    tenantId: tenant.id,
    name: plugin.slug,
    transport: plugin.transport === 'builtin' ? 'builtin' : 'http',
    url: plugin.url,
    catalogId: plugin.id,
    headerCredentials,
    toolPolicy: {}, // everything approval-gated until the owner promotes it
  });

  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'plugin.enable',
    target: plugin.slug,
    detail: { tier: plugin.tier },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
