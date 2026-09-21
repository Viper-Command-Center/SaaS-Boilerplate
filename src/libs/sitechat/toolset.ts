/**
 * Site Chat toolset (Phase 46) — the workspace agent, pinned to ONE site.
 *
 * A church admin chatting from their own wp-admin must be able to change
 * their own website and nothing else. The workspace (ChurchWeb Global) has
 * WHMCS, SmarterMail, Postgres, Zernio, GitHub, Duda and 11 other sites on
 * it; none of that may be reachable from a site's chat. So this is an
 * ALLOW-LIST over the tenant's live toolset, applied twice — to the schemas
 * the model sees and to `resolve()` at execution time — plus a hard pin: every
 * WordPress Sites call has its `site` argument overwritten with this site's
 * label, whatever the model sent.
 *
 * What a site's chat can use:
 *   · WordPress Sites content/media/SEO/cache/builder tools, pinned to the site
 *   · DiviOps / Elementor connections BOUND to this site (wp-site:<label> or same URL)
 *   · diviops_reference, load_connection_tools (for those connections only)
 *   · fetch_url, search_stock_photos, save_file_from_url, view_image, report_issue
 * Everything else is absent from the schema list and refused on resolve.
 * WP-CLI, snapshots, search-replace, plugin install, file writes stay with the
 * operator's workspace — they are account-wide on shared hosting.
 */

import type { AnthropicTool, TenantToolset, ToolPolicy } from '@/libs/mcp/registry';
import { and, eq } from 'drizzle-orm';
import { buildPlatformTools } from '@/libs/agent/platformTools';
import { db } from '@/libs/DB';
import { buildTenantToolset } from '@/libs/mcp/registry';
import { wpSiteLabelOf } from '@/libs/mcp/stdioCatalog';
import { mcpConnections, pluginCatalog } from '@/models/Schema';

/** WordPress Sites tools a site's own admin may drive (original tool names). */
export const SITE_CHAT_WP_TOOLS = new Set([
  'wp_site_status',
  'wp_content_list',
  'wp_content_get',
  'wp_content_create',
  'wp_content_update',
  'wp_content_trash',
  'wp_upload_media',
  'wp_seo_get',
  'wp_seo_update',
  'wp_cache_flush',
  'wp_rest',
  'wp_mcp',
  'wp_mcp_tools',
  'wp_oxygen_replace',
]);

/** Platform tools a site's chat may use. */
export const SITE_CHAT_PLATFORM_TOOLS = new Set([
  'fetch_url',
  'search_stock_photos',
  'save_file_from_url',
  'view_image',
  'report_issue',
]);

/** Bare meta-tools the registry adds (not namespaced). */
const META_TOOLS = new Set(['load_connection_tools', 'diviops_reference']);

/** Builder providers whose per-site connection may be used from that site's chat. */
const LAYOUT_PROVIDERS = new Set(['diviops', 'elementor']);

export type SiteChatToolset = TenantToolset & {
  /** Names of the site-bound layout connections that were let through (for the prompt). */
  layoutConnections: string[];
};

function normUrl(u: string | null | undefined): string {
  return (u ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Connections a site's chat may reach, by name:
 *  · layout — DiviOps/Elementor connections whose target IS this site
 *  · wpSites — the WordPress Sites built-in (identified by PROVIDER, never by
 *    tool name: a hosted server could name a tool "wp-content-list" and it
 *    must not ride in on the allow-list)
 */
export async function siteBoundConnections(tenantId: string, site: { label: string; siteUrl: string }): Promise<{ layout: string[]; wpSites: string[] }> {
  const rows = await db
    .select({ name: mcpConnections.name, url: mcpConnections.url, enabled: mcpConnections.enabled, provider: pluginCatalog.provider })
    .from(mcpConnections)
    .innerJoin(pluginCatalog, eq(pluginCatalog.id, mcpConnections.catalogId))
    .where(and(eq(mcpConnections.tenantId, tenantId), eq(mcpConnections.enabled, true)));
  return {
    layout: rows
      .filter(r => r.provider && LAYOUT_PROVIDERS.has(r.provider))
      .filter(r => wpSiteLabelOf(r.url) === site.label || normUrl(r.url) === normUrl(site.siteUrl))
      .map(r => r.name),
    wpSites: rows.filter(r => r.provider === 'wp-sites').map(r => r.name),
  };
}

const NS_RE = /^mcp__([a-z0-9-]+)__([a-z0-9-]+)$/i;
const sanitize = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const WP_ALLOWED_SANITIZED = new Set([...SITE_CHAT_WP_TOOLS].map(sanitize));

/**
 * Pure: may a tool with this (namespaced or bare) name appear in a site's chat?
 * `bound` = the connection names the site may reach (see siteBoundConnections).
 */
export function isSiteChatToolAllowed(name: string, bound: { layout: string[]; wpSites: string[] }): boolean {
  if (SITE_CHAT_PLATFORM_TOOLS.has(name) || META_TOOLS.has(name)) {
    return true;
  }
  const m = NS_RE.exec(name);
  if (!m) {
    return false;
  }
  const conn = m[1]!.toLowerCase();
  if (bound.layout.some(n => sanitize(n) === conn)) {
    return true;
  }
  return bound.wpSites.some(n => sanitize(n) === conn) && WP_ALLOWED_SANITIZED.has(m[2]!.toLowerCase());
}

/**
 * Build the pinned toolset. `resolveFull` is the tenant's real registry; the
 * returned object is a strict subset of it.
 */
export async function buildSiteChatToolset(tenantId: string, site: { label: string; siteUrl: string }): Promise<SiteChatToolset> {
  const [full, bound] = await Promise.all([
    buildTenantToolset(tenantId),
    siteBoundConnections(tenantId, site),
  ]);
  const layoutConnections = bound.layout;
  const platform = buildPlatformTools(tenantId);
  const wpSanitized = new Set(bound.wpSites.map(sanitize));
  const allowed = (name: string): boolean => isSiteChatToolAllowed(name, bound);

  // Schemas the model sees. The array's push is overridden so schemas that
  // load_connection_tools later fans in (via attachToolSink) are filtered too.
  const visible: AnthropicTool[] = [];
  const rawPush = visible.push.bind(visible);
  visible.push = (...items: AnthropicTool[]) => rawPush(...items.filter(t => allowed(t.name)));
  visible.push(...platform.anthropicTools, ...full.anthropicTools);
  full.attachToolSink(visible);

  // Deferred summary: only the connections this site may load.
  const deferredSummary = full.deferredSummary
    .split(', ')
    .filter(part => layoutConnections.some(n => part.toLowerCase().startsWith(n.toLowerCase())))
    .join(', ');

  // 🔴 NO APPROVALS FROM SITE CHAT. An approval row resumes the conversation
  // through the operator's route with the FULL workspace toolset — that would
  // be a scope escape into a church admin's transcript. Anything that would
  // queue for approval is refused here with a message that names the path.
  const noApproval = (p: ToolPolicy): ToolPolicy => (p === 'approval' ? 'deny' : p);
  const resolve: TenantToolset['resolve'] = (name) => {
    if (!allowed(name)) {
      return {
        connectionId: '',
        connectionName: 'platform',
        toolName: name,
        policy: 'deny' as ToolPolicy,
        call: async () => 'This tool is not available in site chat.',
      };
    }
    const p = platform.executors.get(name);
    if (p) {
      return { connectionId: '', connectionName: 'platform', toolName: name, policy: p.policy, call: p.call };
    }
    const r0 = full.resolve(name);
    if (!r0) {
      return null;
    }
    const r = {
      ...r0,
      policy: noApproval(r0.policy),
      policyFor: r0.policyFor ? async (args: Record<string, unknown>) => noApproval(await r0.policyFor!(args)) : undefined,
    };
    if (r.toolName === 'load_connection_tools') {
      return {
        ...r,
        call: async (args) => {
          const requested = String(args.connection ?? '').trim().toLowerCase();
          if (!layoutConnections.some(n => n.toLowerCase() === requested)) {
            return `Only this site's layout connection can be loaded here: ${layoutConnections.join(', ') || 'none is bound to this site'}.`;
          }
          return r.call(args);
        },
      };
    }
    if (wpSanitized.has(sanitize(r.connectionName)) && SITE_CHAT_WP_TOOLS.has(r.toolName)) {
      // 🔴 THE PIN. Whatever the model sent, the call targets this site.
      const pinned = (args: Record<string, unknown>) => ({ ...args, site: site.label });
      return {
        ...r,
        policyFor: r.policyFor ? args => r.policyFor!(pinned(args)) : undefined,
        call: args => r.call(pinned(args)),
      };
    }
    return r;
  };

  return {
    anthropicTools: visible,
    failedConnections: full.failedConnections.filter(f => layoutConnections.some(n => f.toLowerCase().startsWith(n.toLowerCase())) || /wp-sites/i.test(f)),
    connectionGuidance: full.connectionGuidance,
    deferredSummary,
    attachToolSink: full.attachToolSink,
    resolve,
    layoutConnections,
  };
}
