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
import { getBuiltinProvider } from '@/libs/plugins';
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
      const provider = p.transport === 'builtin' && p.provider ? getBuiltinProvider(p.provider) : undefined;
      const perConnection = Boolean(provider?.perConnection);
      const noCredential = Boolean(provider?.noCredential);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        category: p.category,
        tier: p.tier,
        authHint: p.authHint,
        // Tier 2 = client's own key. Per-connection built-ins (WordPress) also
        // need the client's own credential AND their site URL. noCredential
        // providers (AgentCore browser) need nothing — one click to enable.
        needsKey: !noCredential && (p.tier === 'tier2' || perConnection),
        needsSiteUrl: perConnection,
        installed: installedIds.has(p.id),
        // Show clients what they'll be charged, never our raw cost.
        // Usage-priced plugins (Kie.ai) are one rate for every tool — collapse
        // them to a single line instead of repeating it per tool.
        pricing: (() => {
          const entries = Object.entries(rules);
          const usageRule = entries.find(([, r]) => r.unit === 'usage')?.[1];
          if (usageRule) {
            return [{
              tool: 'all generations',
              unit: provider?.usageMetering?.unitLabel ?? 'unit',
              retailUsd: Number((usageRule.costUsd * (usageRule.markup ?? 1.5)).toFixed(4)),
            }];
          }
          return entries.map(([tool, r]) => ({
            tool,
            unit: r.unit === 'arg' ? (r.argField ?? 'unit') : 'call',
            retailUsd: Number((r.costUsd * (r.markup ?? 1.5)).toFixed(4)),
          }));
        })(),
      };
    }),
  });
}

const EnableSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  pluginId: z.string().uuid(),
  /** tier2 / per-connection built-ins: the workspace's own credential. */
  credentialValue: z.string().max(4000).optional(),
  /** Per-connection built-ins (e.g. WordPress): this workspace's site URL. */
  siteUrl: z.string().url().max(500).optional(),
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

  // Who supplies the credential?
  //  · tier1 + platform provider  → the catalog's key; nothing stored here.
  //  · tier2, or a per-connection built-in (WordPress) → this workspace's own.
  const provider = plugin.transport === 'builtin' && plugin.provider
    ? getBuiltinProvider(plugin.provider)
    : undefined;
  // noCredential providers (AgentCore browser) authenticate with platform AWS
  // keys — there is nothing for the client to supply, even on tier 2.
  const needsOwnCredential = !provider?.noCredential
    && (plugin.tier === 'tier2' || Boolean(provider?.perConnection));

  // Per-connection built-ins (WordPress) target the workspace's own site.
  const targetUrl = provider?.perConnection ? (body.siteUrl ?? '') : plugin.url;
  if (provider?.perConnection && !targetUrl) {
    return NextResponse.json({ error: 'This plugin needs your site URL (e.g. https://yoursite.com).' }, { status: 400 });
  }

  const headerCredentials: Record<string, string> = {};
  if (needsOwnCredential) {
    if (!body.credentialValue) {
      return NextResponse.json({ error: 'This plugin needs your credential.' }, { status: 400 });
    }
    if (!vaultConfigured()) {
      return NextResponse.json({ error: 'Credential vault is not configured.' }, { status: 500 });
    }
    const [cred] = await db
      .insert(credentials)
      .values({
        tenantId: tenant.id,
        provider: plugin.slug,
        label: `${plugin.slug} · ${plugin.authHeader ?? 'credential'}`.slice(0, 120),
        cipher: sealSecret(body.credentialValue),
      })
      .returning({ id: credentials.id });
    if (cred) {
      headerCredentials[plugin.authHeader ?? 'Authorization'] = cred.id;
    }
  } else if (plugin.transport === 'http' && plugin.credentialId) {
    // Tier 1 over HTTP (e.g. Firecrawl on OUR key): the registry reads
    // credentials from the CONNECTION, but the platform key lives on the
    // catalog entry. Point the connection at it so the call is authenticated.
    // The credential row is platform-level (tenantId NULL) and shared — the
    // client never sees the value, only the capability.
    headerCredentials[plugin.authHeader ?? 'Authorization'] = plugin.credentialId;
  }

  await db.insert(mcpConnections).values({
    tenantId: tenant.id,
    name: plugin.slug,
    transport: plugin.transport === 'builtin' ? 'builtin' : 'http',
    url: targetUrl,
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
