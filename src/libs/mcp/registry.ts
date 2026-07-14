/**
 * Tenant tool registry — assembles the live toolset for a tenant from its
 * enabled MCP connections. Tool names are namespaced `mcp__<connection>__<tool>`
 * so the model's tool_use maps back to the right server.
 */

import type { PriceRule } from '@/libs/billing/meter';
import { and, eq, inArray } from 'drizzle-orm';
import { meterPlugin } from '@/libs/billing/meter';
import { db } from '@/libs/DB';
import { McpHttpClient } from '@/libs/mcp/client';
import { getBuiltinProvider } from '@/libs/plugins';
import { archiveGeneratedAssets } from '@/libs/storage/files';
import { openSecret } from '@/libs/vault';
import { credentials, mcpConnections, pluginCatalog } from '@/models/Schema';

export type ToolPolicy = 'auto' | 'approval' | 'deny';

export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type TenantToolset = {
  /** Tools in Anthropic Messages API format, ready for the `tools` param. */
  anthropicTools: AnthropicTool[];
  /** Resolve a namespaced tool name to its executor + policy. */
  resolve: (namespacedName: string) => {
    connectionId: string;
    connectionName: string;
    toolName: string;
    policy: ToolPolicy;
    call: (args: Record<string, unknown>) => Promise<string>;
  } | null;
  /** Names of connections that failed to respond (surfaced to the model). */
  failedConnections: string[];
};

const NAME_RE = /^mcp__([a-z0-9-]+)__(.+)$/i;

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

async function resolveHeaders(
  headerCredentials: unknown,
): Promise<Record<string, string>> {
  const map = (headerCredentials ?? {}) as Record<string, string>;
  const credIds = Object.values(map).filter(Boolean);
  if (credIds.length === 0) {
    return {};
  }
  const rows = await db
    .select({ id: credentials.id, cipher: credentials.cipher })
    .from(credentials)
    .where(inArray(credentials.id, credIds));
  const byId = new Map(rows.map(r => [r.id, r.cipher]));
  const headers: Record<string, string> = {};
  for (const [header, credId] of Object.entries(map)) {
    const cipher = byId.get(credId);
    if (cipher) {
      headers[header] = openSecret(cipher);
    }
  }
  return headers;
}

/**
 * Some vendors put the API key in the URL PATH rather than a header — Firecrawl's
 * hosted MCP is `https://mcp.firecrawl.dev/{key}/v2/mcp`. We must never store that
 * key in `mcp_connections.url`, which is plaintext. So the catalog stores a URL
 * TEMPLATE containing `{key}`, the secret lives in the vault like any other
 * credential (under the reserved name `url`), and it is substituted here, at call
 * time, in memory only.
 */
export const URL_SECRET_KEY = 'url';

export function applyUrlSecret(
  rawUrl: string,
  headers: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  const secret = headers[URL_SECRET_KEY];
  if (!secret) {
    return { url: rawUrl, headers };
  }
  // It's a URL segment, not a header — strip it so we never also send it.
  const { [URL_SECRET_KEY]: _omit, ...rest } = headers;
  return {
    url: rawUrl.replace('{key}', encodeURIComponent(secret)),
    headers: rest,
  };
}

export async function buildTenantToolset(tenantId: string): Promise<TenantToolset> {
  const connections = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.tenantId, tenantId), eq(mcpConnections.enabled, true)));

  const anthropicTools: AnthropicTool[] = [];
  const failedConnections: string[] = [];
  const executors = new Map<string, {
    connectionId: string;
    connectionName: string;
    toolName: string;
    policy: ToolPolicy;
    call: (args: Record<string, unknown>) => Promise<string>;
  }>();

  for (const conn of connections) {
    // ── Built-in (tier-1) provider: in-app adapter, platform credential,
    // metered on every call so the workspace is billed exactly. ──
    if (conn.transport === 'builtin') {
      try {
        const [entry] = conn.catalogId
          ? await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, conn.catalogId)).limit(1)
          : [undefined];
        const provider = entry?.provider ? getBuiltinProvider(entry.provider) : undefined;
        if (!entry || !provider || !entry.enabled) {
          failedConnections.push(`${conn.name} (plugin unavailable)`);
          continue;
        }

        // Where the credential lives depends on the provider:
        //  · noCredential (AgentCore browser) → none; it uses platform AWS keys
        //  · perConnection (WordPress) → the WORKSPACE's own credential + target
        //  · otherwise (Kie.ai)        → the PLATFORM credential on the catalog
        let credentialId: string | undefined;
        let target: string | undefined;

        if (provider.noCredential) {
          credentialId = undefined;
        } else if (provider.perConnection) {
          const map = (conn.headerCredentials ?? {}) as Record<string, string>;
          credentialId = Object.values(map)[0];
          target = conn.url ?? undefined;
          if (!credentialId || !target) {
            failedConnections.push(`${conn.name} (needs a site URL and credential — re-enable it in the Tools panel)`);
            continue;
          }
        } else {
          credentialId = entry.credentialId ?? undefined;
        }
        if (!credentialId && !provider.noCredential) {
          failedConnections.push(`${conn.name} (no credential configured)`);
          continue;
        }

        let apiKey = '';
        if (credentialId) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, credentialId)).limit(1);
          if (!cred) {
            failedConnections.push(`${conn.name} (credential missing)`);
            continue;
          }
          apiKey = openSecret(cred.cipher);
        }
        const rules = (entry.priceRules ?? {}) as Record<string, PriceRule>;
        const policyMap = (conn.toolPolicy ?? {}) as Record<string, ToolPolicy>;

        for (const tool of provider.tools) {
          const namespaced = `mcp__${sanitize(conn.name)}__${tool.name}`;
          anthropicTools.push({
            name: namespaced,
            description: tool.description,
            input_schema: tool.input_schema,
          });
          executors.set(namespaced, {
            connectionId: conn.id,
            connectionName: conn.name,
            toolName: tool.name,
            policy: policyMap[tool.name] ?? 'approval',
            call: async (args) => {
              const raw = await provider.call(tool.name, args, apiKey, target);
              const result = typeof raw === 'string' ? { output: raw } : raw;

              // Meter AFTER a successful call (failed jobs aren't charged).
              // `units` = what the provider says it actually consumed (Kie.ai
              // returns creditsConsumed), so usage-priced plugins bill exactly.
              const rule = rules[tool.name];
              if (rule) {
                await meterPlugin({
                  tenantId,
                  slug: entry.slug,
                  tool: tool.name,
                  rule,
                  args,
                  reportedUnits: result.units,
                });
              }

              // Generated media expires at the provider (Kie.ai: 14 days) —
              // archive it into the workspace library so published links live.
              if (result.assetUrls?.length) {
                const saved = await archiveGeneratedAssets({
                  tenantId,
                  urls: result.assetUrls,
                  source: entry.slug,
                  meta: { tool: tool.name, args },
                }).catch(() => []);
                if (saved.length > 0) {
                  return `${result.output}\n\nArchived to the workspace file library (permanent links — use these, not the provider URLs):\n${
                    saved.map(s => `- ${s.name}: ${s.url ?? `/api/files/${s.id}/content`}`).join('\n')
                  }`;
                }
              }

              return result.output;
            },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unavailable';
        failedConnections.push(`${conn.name} (${msg.slice(0, 120)})`);
      }
      continue;
    }

    if (conn.transport !== 'http' || !conn.url) {
      failedConnections.push(`${conn.name} (unsupported transport — only hosted HTTP MCP servers and built-in plugins are supported)`);
      continue;
    }
    try {
      const headers = await resolveHeaders(conn.headerCredentials);
      const { url, headers: safeHeaders } = applyUrlSecret(conn.url, headers);
      const client = new McpHttpClient(url, safeHeaders);
      const tools = await client.listTools();
      const policyMap = (conn.toolPolicy ?? {}) as Record<string, ToolPolicy>;

      for (const tool of tools) {
        const namespaced = `mcp__${sanitize(conn.name)}__${tool.name}`;
        anthropicTools.push({
          name: namespaced,
          description: (tool.description ?? tool.name).slice(0, 1000),
          input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
        });
        executors.set(namespaced, {
          connectionId: conn.id,
          connectionName: conn.name,
          toolName: tool.name,
          // Safe by default: tools without an explicit policy need approval.
          policy: policyMap[tool.name] ?? 'approval',
          call: async (args) => {
            const result = await client.callTool(tool.name, args);
            const text = result.content
              .map(c => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
              .join('\n')
              .slice(0, 20_000);
            if (result.isError) {
              throw new Error(text || 'Tool reported an error.');
            }
            return text || '(no output)';
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unreachable';
      failedConnections.push(`${conn.name} (${msg.slice(0, 120)})`);
    }
  }

  return {
    anthropicTools,
    failedConnections,
    resolve: (namespacedName) => {
      const match = NAME_RE.exec(namespacedName);
      if (!match) {
        return null;
      }
      return executors.get(namespacedName) ?? null;
    },
  };
}
