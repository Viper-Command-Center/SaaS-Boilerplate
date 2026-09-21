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
import { getStdioServer, WP_SITE_TARGET_PREFIX, wpSiteLabelOf } from '@/libs/mcp/stdioCatalog';
import { getBuiltinProvider } from '@/libs/plugins';
import { getUserTenants } from '@/libs/tenants';
import { sealSecret, vaultConfigured } from '@/libs/vault';
import { normaliseLabel } from '@/libs/wpsites/auth';
import { listSites } from '@/libs/wpsites/store';
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
    .select({ catalogId: mcpConnections.catalogId, enabled: mcpConnections.enabled, url: mcpConnections.url })
    .from(mcpConnections)
    .where(eq(mcpConnections.tenantId, tenant.id));
  const installedIds = new Set(installed.map(i => i.catalogId).filter(Boolean));
  // Phase 44: per-site stdio servers (DiviOps) can be connected once PER
  // REGISTERED SITE, borrowing the WordPress Sites credential. Offer the
  // labels not yet bound so the panel can show "connect another site".
  const siteLabels = (await listSites(tenant.id).catch(() => [])).map(s => s.label);

  return NextResponse.json({
    plugins: catalog.map((p) => {
      const rules = (p.priceRules ?? {}) as Record<string, { unit: string; costUsd: number; markup?: number; argField?: string }>;
      const provider = p.transport === 'builtin' && p.provider ? getBuiltinProvider(p.provider) : undefined;
      // stdio plugins (DiviOps…) are per-connection like WordPress: the
      // workspace supplies its own site URL + credential when enabling.
      const stdioSpec = p.transport === 'stdio' && p.provider ? getStdioServer(p.provider) : undefined;
      const perConnection = Boolean(provider?.perConnection) || Boolean(stdioSpec?.perConnection);
      const noCredential = Boolean(provider?.noCredential);
      const multiSite = Boolean(stdioSpec?.perConnection);
      const boundLabels = new Set(installed.filter(i => i.catalogId === p.id).map(i => wpSiteLabelOf(i.url)).filter(Boolean));
      return {
        multiSite,
        wpSiteLabels: multiSite ? siteLabels.filter(l => !boundLabels.has(l)) : [],
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
        // Phase 30.1: what to ASK for. stdio per-connection servers (DiviOps)
        // are genuinely site URLs; built-ins declare their own.
        targetLabel: provider?.targetLabel ?? 'Site URL',
        targetPlaceholder: provider?.targetPlaceholder ?? 'Your site URL — https://yoursite.com',
        targetIsUrl: provider ? provider.targetIsUrl !== false : true,
        // 'ssh-key' = the Tools panel offers "Generate SSH key" instead of a paste box.
        credentialKind: provider?.credentialKind ?? null,
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
  /**
   * Per-connection target. NOT necessarily a URL — WordPress and DiviOps want a
   * site, Google Analytics wants a numeric GA4 property ID. Shape is checked
   * against the provider's `targetIsUrl` below, where we actually know which
   * provider this is; a blanket z.string().url() here made valid targets
   * unenterable (Phase 30.1).
   */
  siteUrl: z.string().min(1).max(500).optional(),
  /**
   * A credential row ALREADY sealed for this workspace — today only the SSH
   * private key minted by POST /api/plugins/ssh-key. Verified below to belong
   * to this tenant AND this plugin, so a stray id cannot borrow another
   * workspace's (or the platform's) secret.
   */
  credentialId: z.string().uuid().optional(),
  /**
   * Phase 44: bind a per-site stdio server (DiviOps) to a WordPress Sites
   * entry by label. The connection then stores `wp-site:<label>` and NO
   * credential of its own — the registry reads the site's URL + application
   * password from wp_sites at spawn time. Several such connections may exist
   * (one per site); they are named `<plugin>-<label>`.
   */
  wpSiteLabel: z.string().min(1).max(80).optional(),
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

  // Who supplies the credential?
  //  · tier1 + platform provider  → the catalog's key; nothing stored here.
  //  · tier2, or a per-connection built-in (WordPress) → this workspace's own.
  const provider = plugin.transport === 'builtin' && plugin.provider
    ? getBuiltinProvider(plugin.provider)
    : undefined;
  const stdioSpec = plugin.transport === 'stdio' && plugin.provider
    ? getStdioServer(plugin.provider)
    : undefined;
  const perConnection = Boolean(provider?.perConnection) || Boolean(stdioSpec?.perConnection);

  // Phase 44: a per-site stdio server bound to a WordPress Sites entry.
  const boundLabel = stdioSpec?.perConnection && body.wpSiteLabel ? normaliseLabel(body.wpSiteLabel) : null;
  if (body.wpSiteLabel && !boundLabel) {
    return NextResponse.json({ error: 'Only per-site stdio plugins (e.g. DiviOps) can be bound to a WordPress Sites entry.' }, { status: 400 });
  }
  if (boundLabel) {
    const site = (await listSites(tenant.id)).find(s => s.label === boundLabel);
    if (!site) {
      return NextResponse.json({ error: `No WordPress site labelled "${boundLabel}" in this workspace — add it under WordPress Sites first.` }, { status: 400 });
    }
    if (site.authScheme !== 'basic') {
      return NextResponse.json({ error: `Site "${boundLabel}" uses a bearer token; ${plugin.name} needs a username + application password. Edit the site to use an application password.` }, { status: 400 });
    }
  }

  const existing = await db
    .select({ id: mcpConnections.id, name: mcpConnections.name, url: mcpConnections.url })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.tenantId, tenant.id), eq(mcpConnections.catalogId, plugin.id)));
  const connectionName = boundLabel ? `${plugin.slug}-${boundLabel}`.slice(0, 40) : plugin.slug;
  if (boundLabel) {
    if (existing.some(e => wpSiteLabelOf(e.url) === boundLabel)) {
      return NextResponse.json({ error: `${plugin.name} is already connected to site "${boundLabel}".` }, { status: 409 });
    }
    if (existing.some(e => e.name === connectionName)) {
      return NextResponse.json({ error: `A connection named "${connectionName}" already exists — remove it first.` }, { status: 409 });
    }
  } else if (existing.length > 0) {
    return NextResponse.json({
      error: stdioSpec?.perConnection
        ? 'Already enabled in this workspace. To add another site, pick a registered WordPress site (wpSiteLabel).'
        : 'Already enabled in this workspace.',
    }, { status: 409 });
  }

  // noCredential providers (AgentCore browser) authenticate with platform AWS
  // keys — there is nothing for the client to supply, even on tier 2. A
  // connection bound to a WordPress site borrows that site's credential.
  const needsOwnCredential = !provider?.noCredential && !boundLabel
    && (plugin.tier === 'tier2' || perConnection);

  // Per-connection plugins (WordPress, DiviOps) target the workspace's own site.
  const targetUrl = boundLabel
    ? `${WP_SITE_TARGET_PREFIX}${boundLabel}`
    : perConnection ? (body.siteUrl ?? '') : plugin.url;
  // Validate the target against what THIS provider says it needs.
  if (perConnection && !boundLabel && targetUrl && provider?.targetIsUrl !== false) {
    try {
      void new URL(targetUrl);
    } catch {
      return NextResponse.json(
        { error: `${provider?.targetLabel ?? 'Site URL'} must be a full URL including https://.` },
        { status: 400 },
      );
    }
  }
  if (perConnection && !targetUrl) {
    return NextResponse.json({ error: 'This plugin needs your site URL (e.g. https://yoursite.com).' }, { status: 400 });
  }

  const headerCredentials: Record<string, string> = {};
  if (needsOwnCredential && body.credentialId) {
    const [own] = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(
        eq(credentials.id, body.credentialId),
        eq(credentials.tenantId, tenant.id),
        eq(credentials.provider, plugin.slug),
      ))
      .limit(1);
    if (!own) {
      return NextResponse.json({ error: 'That generated key does not belong to this workspace and plugin — generate it again.' }, { status: 400 });
    }
    headerCredentials[plugin.authHeader ?? 'Authorization'] = own.id;
  } else if (needsOwnCredential) {
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
    name: connectionName,
    transport: plugin.transport === 'builtin' ? 'builtin' : plugin.transport === 'stdio' ? 'stdio' : 'http',
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
    detail: { tier: plugin.tier, ...(boundLabel ? { wpSite: boundLabel } : {}) },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
