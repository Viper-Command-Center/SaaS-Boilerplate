/**
 * Tenant tool registry — assembles the live toolset for a tenant from its
 * enabled MCP connections. Tool names are namespaced `mcp__<connection>__<tool>`
 * so the model's tool_use maps back to the right server.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { McpHttpClient } from '@/libs/mcp/client';
import { openSecret } from '@/libs/vault';
import { credentials, mcpConnections } from '@/models/Schema';

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
    if (conn.transport !== 'http' || !conn.url) {
      failedConnections.push(`${conn.name} (stdio transport arrives with the Phase 4 worker)`);
      continue;
    }
    try {
      const headers = await resolveHeaders(conn.headerCredentials);
      const client = new McpHttpClient(conn.url, headers);
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
