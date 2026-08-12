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
import { getStdioServer } from '@/libs/mcp/stdioCatalog';
import { acquireStdioClient } from '@/libs/mcp/stdioClient';
import { getBuiltinProvider } from '@/libs/plugins';
import { archiveGeneratedAssets } from '@/libs/storage/files';
import { captureIssue } from '@/libs/support/issues';
import { openSecret } from '@/libs/vault';
import { credentials, mcpConnections, pluginCatalog } from '@/models/Schema';

export type ToolPolicy = 'auto' | 'approval' | 'deny';

export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** The executor + policy behind a namespaced tool name. */
type ExecutorEntry = {
  connectionId: string;
  connectionName: string;
  toolName: string;
  policy: ToolPolicy;
  call: (args: Record<string, unknown>) => Promise<string>;
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
  /**
   * Cross-tool operating notes from the built-in providers this workspace has
   * ENABLED (Phase 32), joined and ready for the system prompt. Empty when no
   * enabled provider declares any. See BuiltinProvider.guidance for why this
   * lives with the adapter rather than in each workspace's memory.
   */
  connectionGuidance: string;
  /**
   * One-line summary of tool collections DEFERRED to keep context small
   * (Phase 29). Empty string when nothing was deferred. Surfaced into the
   * system prompt by every assembler so the model knows they exist and how to
   * load them, e.g.:
   *   "zernio (51 tools: posts-create, …), diviops (74 tools: …)"
   */
  deferredSummary: string;
  /**
   * Register an EXTRA array that newly-loaded deferred schemas must ALSO be
   * pushed into (Phase 29.1).
   *
   * Every assembler (chat, approvals-resume, run-scheduled) concatenates
   * platform + mission + MCP tools into a NEW array and hands THAT to the tool
   * loop. So mutating the registry's own `anthropicTools` — which is what
   * load_connection_tools does — was invisible to the model: it got told
   * "Loaded 51 tools" and then could not see a single one of them. Assemblers
   * must call this with the combined array they pass to runToolLoop.
   */
  attachToolSink: (sink: AnthropicTool[]) => void;
};

/** One block of an MCP tool result's `content` array. */
type McpContentBlock = { type: string; text?: string; [k: string]: unknown };

/**
 * Flatten an MCP tool result's content blocks into the single string the agent
 * sees.
 *
 * 🔴 WHY THIS IS NOT `blocks.map(b => b.text)` — the GitHub read incident
 * (2026-08-05, Phase 29.2). The MCP spec has several content shapes and FILE
 * READS DO NOT USE `text`: GitHub's MCP returns `get_file_contents` as an
 * EmbeddedResource — `{ type: 'resource', resource: { uri, mimeType, text } }`.
 * The old code mapped every non-text block to the literal marker `[<type>]`, so
 * every file the agent read out of a repo arrived as the ten characters
 * `[resource]` and the real contents were thrown away.
 *
 * The failure was invisible from the outside because WRITES were unaffected —
 * `create_or_update_file` returns a `text` confirmation. So the connection
 * looked healthy, the agent could commit but never read, and it concluded it
 * "cannot read private repos" and fell back to fetch_url on
 * raw.githubusercontent.com (which 404s on a private repo). Classic Phase
 * 21/24 shape: the platform silently lied and the agent took the blame.
 *
 * Binary blobs are deliberately NOT inlined — a base64 payload would burn the
 * context window and the model cannot read it anyway. We describe it instead.
 */
function flattenMcpContent(blocks: McpContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text ?? '';
      }
      if (block.type === 'resource') {
        const res = block.resource as
          | { uri?: string; mimeType?: string; text?: string; blob?: string }
          | undefined;
        if (typeof res?.text === 'string') {
          return res.text;
        }
        if (typeof res?.blob === 'string') {
          const kb = Math.round((res.blob.length * 3) / 4 / 1024);
          return `[binary resource, ${res.mimeType ?? 'unknown type'}, ~${kb}KB, uri: ${res.uri ?? 'unknown'} — not inlined. Use a tool that returns a download URL, then save_file_from_url.]`;
        }
        return `[resource carried neither text nor blob: ${res?.uri ?? 'unknown uri'}]`;
      }
      if (block.type === 'resource_link') {
        const uri = typeof block.uri === 'string' ? block.uri : 'unknown uri';
        const name = typeof block.name === 'string' ? ` (${block.name})` : '';
        return `[resource link${name}: ${uri}]`;
      }
      return `[${block.type}]`;
    })
    .join('\n');
}

const NAME_RE = /^mcp__([a-z0-9-]+)__.+$/i;

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Anthropic/Bedrock require every tool name to match ^[a-zA-Z0-9_-]{1,64}$.
 *
 * 🔴 WHY THIS FUNCTION EXISTS — the failure it prevents is workspace-wide and
 * silently misattributed:
 *
 * We namespace as `mcp__<connection>__<tool>`. The connection half is ours and
 * already validated. **The tool half comes from a third-party server** and was
 * passed through verbatim. A hosted MCP exposing `notion-create.page` or
 * `search files` — or simply a long name that pushes the total past 64 — puts
 * an ILLEGAL entry in the `tools` array. Anthropic then 400s the ENTIRE request.
 *
 * So one badly-named tool on one server killed every tool in the workspace, and
 * the Tools panel showed that server as perfectly healthy — because
 * buildTenantToolset() succeeded. The failure happened later, in
 * callClaudeWithTools, with nothing in failedConnections to name the culprit.
 *
 * The lesson generalises: the per-connection try/catch isolates failures at the
 * FETCH boundary, but the tools array is a SHARED structure that the API
 * validates as a whole. Anything poisoning that array escapes the isolation.
 * Validate at the boundary that's actually checked.
 */
const MAX_TOOL_NAME = 64;

export function namespacedToolName(connectionName: string, toolName: string): string | null {
  const conn = sanitize(connectionName);
  // Underscores are legal for Anthropic but are our namespace separator, so a
  // tool named `a__b` could forge a different connection. Map them to '-'.
  const tool = toolName.replace(/[^a-z0-9-]/gi, '-');
  if (!tool.replace(/-/g, '')) {
    return null; // nothing legal left to name it with
  }
  const full = `mcp__${conn}__${tool}`;
  // Truncating would risk two tools colliding on the same key, which is the
  // duplicate-name 400 in a different costume. Refuse instead, and report it.
  return full.length <= MAX_TOOL_NAME ? full : null;
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

// ── Deferred tool loading (Phase 29 token diet) ─────────────────────────────
// The full tool catalog (~77k tokens; Zernio alone is 51 schemas, DiviOps 74)
// used to be re-sent on EVERY model call even when unused — the single biggest
// cost lever. Now: a connection with ≥ DEFER_THRESHOLD tools ships NO schemas
// up front; instead its tools are stashed and a single meta-tool
// `load_connection_tools` pulls them into the live tools array on demand. The
// deferral is a pure token optimization — resolve() auto-loads on first use, so
// a model that calls a deferred tool without loading it first still works.
const DEFER_THRESHOLD = 10;
const LOAD_TOOLS_META_NAME = 'load_connection_tools';

/** A tool prepared for a connection: its API def + its executor. */
type PreparedTool = { toolName: string; def: AnthropicTool; executor: ExecutorEntry };

export async function buildTenantToolset(tenantId: string): Promise<TenantToolset> {
  const connections = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.tenantId, tenantId), eq(mcpConnections.enabled, true)))
    // 🔑 ORDER BY IS LOAD-BEARING — it is a COST control, not tidiness.
    // Tool definitions sit in the cached prefix (order: tools → system →
    // messages), and a cache key is the exact prefix bytes. Without ORDER BY,
    // Postgres returns heap order — which silently changes the moment any row is
    // UPDATEd (MVCC rewrites the tuple at the end of the heap). So toggling
    // `enabled`, renaming a connection, or rotating a key would reshuffle the
    // whole tool list and invalidate ~77k tokens of cache at a 1.25x write, with
    // nothing visible to explain the bill.
    .orderBy(mcpConnections.name);

  const anthropicTools: AnthropicTool[] = [];
  const failedConnections: string[] = [];
  /**
   * provider slug → its guidance. A Map so two connections to the same
   *  provider contribute the paragraph once, not twice.
   */
  const guidanceByProvider = new Map<string, string>();
  const executors = new Map<string, ExecutorEntry>();
  // Extra arrays (the assemblers' combined tool lists) that must also receive
  // schemas when a deferred group loads. See attachToolSink on TenantToolset.
  const toolSinks: AnthropicTool[][] = [];

  // Deferred connections: their prepared tools, kept out of anthropicTools
  // until load_connection_tools (or resolve auto-load) pulls them in.
  const deferralEnabled = process.env.DISABLE_TOOL_DEFERRAL !== '1';
  const deferredGroups: Array<{ connectionName: string; sanitized: string; prepared: PreparedTool[] }> = [];

  /**
   * Take a connection's prepared tools and either ship them now or defer them.
   * A connection at/above the threshold is deferred (when deferral is on);
   * everything else is added to the live arrays immediately.
   */
  function commitConnectionTools(connectionName: string, prepared: PreparedTool[]): void {
    if (deferralEnabled && prepared.length >= DEFER_THRESHOLD) {
      deferredGroups.push({ connectionName, sanitized: sanitize(connectionName), prepared });
      return;
    }
    for (const p of prepared) {
      anthropicTools.push(p.def);
      executors.set(p.def.name, p.executor);
    }
  }

  /**
   * Pull a deferred group's tools into the LIVE arrays. Mutating the same
   * `anthropicTools` instance is deliberate: the loop passes
   * `a.toolset.anthropicTools` on every call, so the newly-added schemas take
   * effect on the model's next step. Expanding a group busts the tools+system
   * cache prefix once — an accepted trade for not shipping 77k idle tokens
   * every turn. Returns the loaded group (or null if there was none).
   */
  function loadDeferredGroup(
    match: (g: { connectionName: string; sanitized: string }) => boolean,
  ): { connection: string; names: string[] } | null {
    const idx = deferredGroups.findIndex(match);
    if (idx === -1) {
      return null;
    }
    const [group] = deferredGroups.splice(idx, 1);
    if (!group) {
      return null;
    }
    for (const p of group.prepared) {
      anthropicTools.push(p.def);
      for (const sink of toolSinks) {
        sink.push(p.def);
      }
      executors.set(p.def.name, p.executor);
    }
    return { connection: group.connectionName, names: group.prepared.map(p => p.toolName) };
  }

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

        // Keyed by provider slug, not connection name: two connections to the
        // same provider (two client sites in one workspace) must not repeat the
        // same paragraph twice in the system prompt.
        if (provider.guidance) {
          guidanceByProvider.set(provider.slug, provider.guidance.trim());
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
          /**
           * 🔴 TIER 2 ON A NON-PER-CONNECTION BUILT-IN WAS UNREACHABLE.
           *
           * This branch used to read ONLY the catalog's platform credential —
           * correct for tier 1, where the key is ours. But `/api/plugins` POST
           * computes `needsOwnCredential = tier === 'tier2' || perConnection`,
           * so a TIER 2 built-in prompts the workspace for a key, seals it in
           * the vault, and stores it on `conn.headerCredentials` — and nothing
           * ever read it back. The connection then reported "no credential
           * configured" about a credential the platform had just accepted,
           * encrypted and saved.
           *
           * That is the worst shape of error: the UI confirms a save, the vault
           * genuinely holds the secret, and the agent is told it is missing. The
           * owner re-enters it, gets the same message, and reasonably concludes
           * the format is wrong.
           *
           * Prefer the platform key (tier 1), fall back to the workspace's own
           * (tier 2) — the same precedence the HTTP branch already uses.
           */
          const own = Object.values((conn.headerCredentials ?? {}) as Record<string, string>)[0];
          credentialId = entry.credentialId ?? own ?? undefined;
        }
        if (!credentialId && !provider.noCredential) {
          // Name WHERE the credential belongs. "No credential configured" sent
          // the owner to the workspace Tools panel, which for a tier-1 built-in
          // has no credential field at all — so the message pointed at a screen
          // that could not fix it.
          failedConnections.push(
            `${conn.name} (no credential configured — for a Tier 1 plugin the key lives on the CATALOG entry: Admin → Plugin catalog → Edit "${entry.slug}" → paste the key. The workspace Tools panel has no key field for Tier 1, because the credential is the platform's, not this workspace's.)`,
          );
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

        const prepared: PreparedTool[] = [];
        for (const tool of provider.tools) {
          const namespaced = namespacedToolName(conn.name, tool.name);
          if (!namespaced) {
            // Ours, so this is a bug to fix rather than a vendor quirk — but it
            // still must not poison the shared array.
            failedConnections.push(`${conn.name} (built-in tool "${tool.name}" has an unusable name)`);
            continue;
          }
          prepared.push({
            toolName: tool.name,
            def: {
              name: namespaced,
              description: tool.description,
              input_schema: tool.input_schema,
            },
            executor: {
              connectionId: conn.id,
              connectionName: conn.name,
              toolName: tool.name,
              // Per-tool wins; `*` is the connection-wide default; approval is the
              // fallback. The wildcard exists because per-tool config is unusable
              // at scale — Zernio alone exposes 51 tools, and nobody is setting 51
              // switches to say "I trust this vendor".
              policy: policyMap[tool.name] ?? policyMap['*'] ?? 'approval',
              call: async (args) => {
                const raw = await provider.call(tool.name, args, apiKey, target, { tenantId });
                const result = typeof raw === 'string' ? { output: raw } : raw;

                // An async job that outran our poll window WILL still be billed
                // by the provider — flag it (Issues inbox, provider-class so it
                // logs without emailing) instead of recording a silent $0.
                if (result.pendingReconcile) {
                  await captureIssue({
                    tenantId,
                    source: `${entry.slug}:${tool.name} (unbilled — job still running)`,
                    error: new Error(`Kie job ${result.pendingReconcile} exceeded the poll window; credits consumed are not yet billed. Reconcile via recordInfo.`),
                    detail: { taskId: result.pendingReconcile, slug: entry.slug, tool: tool.name },
                    forceKind: 'provider', // log it, but don't email — it's expected, not a bug
                  }).catch(() => {});
                }

                // Meter AFTER a successful call (failed jobs aren't charged).
                // `units` = what the provider says it actually consumed (Kie.ai
                // returns creditsConsumed), so usage-priced plugins bill exactly.
                const rule = rules[tool.name];
                if (rule && result.units !== undefined) {
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
            },
          });
        }
        commitConnectionTools(conn.name, prepared);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unavailable';
        failedConnections.push(`${conn.name} (${msg.slice(0, 120)})`);
      }
      continue;
    }

    // ── stdio (Phase 4): a bundled, ALLOWLISTED MCP server run as a child
    // process on this container. Most of the MCP ecosystem is stdio-only
    // (built for Claude Code / Cursor); this branch makes those servers
    // first-class connections. The connection stores only the allowlist KEY
    // (its catalog entry's provider column) — the executable resolves from
    // OUR package.json in stdioCatalog.ts, never from user input.
    if (conn.transport === 'stdio') {
      try {
        const [entry] = conn.catalogId
          ? await db.select().from(pluginCatalog).where(eq(pluginCatalog.id, conn.catalogId)).limit(1)
          : [undefined];
        const spec = entry?.provider ? getStdioServer(entry.provider) : undefined;
        if (!entry || !spec || !entry.enabled) {
          failedConnections.push(`${conn.name} (plugin unavailable)`);
          continue;
        }
        // The workspace's sealed credential + the connection's target (url
        // field) become the child env — mapping decided by the allowlist spec.
        const secrets = await resolveHeaders(conn.headerCredentials);
        const credentialValue = Object.values(secrets)[0] ?? '';
        const env = spec.buildEnv(conn.url ?? '', credentialValue);
        const client = acquireStdioClient(conn.id, spec.resolveEntry(), env, conn.name);
        const tools = await client.listTools();
        const policyMap = (conn.toolPolicy ?? {}) as Record<string, ToolPolicy>;

        // 🔴 tool.name is THIRD-PARTY DATA — same rule as the http branch:
        // one illegal name must never poison the shared tools array.
        const skipped: string[] = [];
        const prepared: PreparedTool[] = [];
        for (const tool of tools) {
          const namespaced = namespacedToolName(conn.name, tool.name);
          if (!namespaced) {
            skipped.push(tool.name);
            continue;
          }
          prepared.push({
            toolName: tool.name,
            def: {
              name: namespaced,
              description: (tool.description ?? tool.name).slice(0, 1000),
              input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
            },
            executor: {
              connectionId: conn.id,
              connectionName: conn.name,
              toolName: tool.name,
              // Safe by default: per-tool wins; `*` is the connection-wide
              // default; approval is the fallback. Especially right here —
              // DiviOps exposes 74 tools that WRITE to a client's live site.
              policy: policyMap[tool.name] ?? policyMap['*'] ?? 'approval',
              call: async (args) => {
                const result = await client.callTool(tool.name, args);
                const text = flattenMcpContent(result.content).slice(0, 20_000);
                if (result.isError) {
                  throw new Error(text || 'Tool reported an error.');
                }
                return text || '(no output)';
              },
            },
          });
        }
        commitConnectionTools(conn.name, prepared);
        if (skipped.length > 0) {
          failedConnections.push(
            `${conn.name} (${skipped.length} tool(s) unavailable — names are too long or use unsupported characters: ${skipped.slice(0, 5).join(', ')})`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unreachable';
        failedConnections.push(`${conn.name} (${msg.slice(0, 160)})`);
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

      // A tier-1 HTTP plugin (our key, resold with markup) can carry priceRules
      // on its catalog entry. Load them so paid HTTP tools meter exactly like
      // built-in ones — otherwise a resold HTTP MCP would run for free.
      let httpRules: Record<string, PriceRule> = {};
      let httpSlug = conn.name;
      if (conn.catalogId) {
        const [catEntry] = await db
          .select({ slug: pluginCatalog.slug, priceRules: pluginCatalog.priceRules })
          .from(pluginCatalog)
          .where(eq(pluginCatalog.id, conn.catalogId))
          .limit(1);
        if (catEntry) {
          httpRules = (catEntry.priceRules ?? {}) as Record<string, PriceRule>;
          httpSlug = catEntry.slug;
        }
      }

      // 🔴 tool.name is THIRD-PARTY DATA. An illegal or over-long name here used
      // to be pushed verbatim into the shared tools array, which Anthropic then
      // rejected as a whole — killing every tool in the workspace while this
      // connection still looked healthy. Skip the offender, name it, keep going.
      const skipped: string[] = [];
      const prepared: PreparedTool[] = [];
      for (const tool of tools) {
        const namespaced = namespacedToolName(conn.name, tool.name);
        if (!namespaced) {
          skipped.push(tool.name);
          continue;
        }
        prepared.push({
          toolName: tool.name,
          def: {
            name: namespaced,
            description: (tool.description ?? tool.name).slice(0, 1000),
            input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
          },
          executor: {
            connectionId: conn.id,
            connectionName: conn.name,
            toolName: tool.name,
            // Safe by default: tools without an explicit policy need approval.
            // Per-tool wins; `*` is the connection-wide default; approval is the
            // fallback. The wildcard exists because per-tool config is unusable
            // at scale — Zernio alone exposes 51 tools, and nobody is setting 51
            // switches to say "I trust this vendor".
            policy: policyMap[tool.name] ?? policyMap['*'] ?? 'approval',
            call: async (args) => {
              const result = await client.callTool(tool.name, args);
              const text = flattenMcpContent(result.content).slice(0, 20_000);
              if (result.isError) {
                throw new Error(text || 'Tool reported an error.');
              }
              // Meter AFTER success (a thrown error above is never billed).
              const rule = httpRules[tool.name];
              if (rule) {
                await meterPlugin({ tenantId, slug: httpSlug, tool: tool.name, rule, args });
              }
              return text || '(no output)';
            },
          },
        });
      }
      commitConnectionTools(conn.name, prepared);
      if (skipped.length > 0) {
        // Honest and specific: the agent is told which capabilities it does NOT
        // have and why, instead of silently missing them (or, worse, the whole
        // request 400ing with no attribution).
        failedConnections.push(
          `${conn.name} (${skipped.length} tool(s) unavailable — names are too long or use unsupported characters: ${skipped.slice(0, 5).join(', ')})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unreachable';
      failedConnections.push(`${conn.name} (${msg.slice(0, 120)})`);
    }
  }

  // ── Meta-tool + summary for the deferred groups ───────────────────────────
  // Only when something was actually deferred: add ONE tool the model can call
  // to pull a collection's schemas into play, and build the one-line summary
  // the assemblers append to the system prompt.
  let deferredSummary = '';
  if (deferredGroups.length > 0) {
    deferredSummary = deferredGroups
      .map((g) => {
        const names = g.prepared.map(p => p.toolName);
        const first = names.slice(0, 8).join(', ');
        return `${g.connectionName} (${names.length} tools: ${first}${names.length > 8 ? ', …' : ''})`;
      })
      .join(', ');

    anthropicTools.push({
      name: LOAD_TOOLS_META_NAME,
      description: 'Load the full tool schemas for a DEFERRED connection into play. Large tool collections are hidden by default to keep context small; call this once with the connection name (as listed in the "DEFERRED" note in your instructions) before using that connection\'s tools. The tools become available on your NEXT step.',
      input_schema: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'The connection name, e.g. "zernio" or "diviops".' },
        },
        required: ['connection'],
      },
    });
    executors.set(LOAD_TOOLS_META_NAME, {
      connectionId: '',
      connectionName: 'platform',
      toolName: LOAD_TOOLS_META_NAME,
      policy: 'auto',
      call: async (args) => {
        const requested = String((args as Record<string, unknown>).connection ?? '').trim();
        if (!requested) {
          return 'load_connection_tools needs a connection name.';
        }
        const wanted = requested.toLowerCase();
        const wantedSanitized = sanitize(requested);
        const loaded = loadDeferredGroup(
          g => g.connectionName.toLowerCase() === wanted || g.sanitized === wantedSanitized,
        );
        if (!loaded) {
          const remaining = deferredGroups.map(g => g.connectionName);
          return remaining.length > 0
            ? `No deferred collection named "${requested}". Already loaded, or unknown. Deferred collections still available: ${remaining.join(', ')}.`
            : `No deferred collection named "${requested}" — everything is already loaded.`;
        }
        const preview = loaded.names.slice(0, 12).join(', ');
        return `Loaded ${loaded.names.length} tools from ${loaded.connection}: ${preview}${loaded.names.length > 12 ? ', …' : ''}. They are available from your next step.`;
      },
    });
  }

  return {
    anthropicTools,
    failedConnections,
    connectionGuidance: [...guidanceByProvider.values()].join('\n\n'),
    deferredSummary,
    attachToolSink: (sink) => {
      toolSinks.push(sink);
    },
    resolve: (namespacedName) => {
      // 🔴 PHASE 29.1 — look up the flat executor map FIRST.
      // Meta-tools like `load_connection_tools` are registered under a BARE
      // name; they are NOT namespaced `mcp__<conn>__<tool>`. Gating on NAME_RE
      // before the map lookup made the deferral meta-tool unresolvable, so
      // every call to it returned "Unknown tool: load_connection_tools" and
      // every deferred connection (github, zernio, diviops) was unreachable —
      // the deferral became the functional wall it was explicitly not allowed
      // to be. Order matters here; do not "tidy" the regex back to the top.
      const found = executors.get(namespacedName);
      if (found) {
        return found;
      }
      const match = NAME_RE.exec(namespacedName);
      if (!match) {
        return null;
      }
      // Not loaded yet — but it might belong to a DEFERRED collection. The
      // deferral is a token optimization, never a functional wall: auto-load
      // the owning group (matched by the sanitized connection segment) and
      // retry, so a model that skipped load_connection_tools still works.
      const connSegment = match[1] ?? '';
      const loaded = loadDeferredGroup(g => g.sanitized === connSegment);
      if (loaded) {
        return executors.get(namespacedName) ?? null;
      }
      return null;
    },
  };
}
