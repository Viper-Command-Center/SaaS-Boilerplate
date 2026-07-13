/**
 * Minimal MCP client — JSON-RPC 2.0 over Streamable HTTP, via fetch only
 * (no SDK deps). Enough for tools/list + tools/call against hosted MCP
 * servers. stdio transport arrives with the worker service (Phase 4).
 */

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpCallResult = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
};

const PROTOCOL_VERSION = '2025-03-26';

type Transport = {
  url: string;
  headers: Record<string, string>;
  sessionId?: string;
  protocolVersion?: string;
};

async function rpc(t: Transport, method: string, params?: unknown, id?: number): Promise<unknown> {
  const resp = await fetch(t.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(t.sessionId ? { 'Mcp-Session-Id': t.sessionId } : {}),
      // Required by servers implementing the 2025-06-18 spec (e.g. GitHub's
      // hosted MCP) on every request after initialize.
      ...(t.protocolVersion ? { 'MCP-Protocol-Version': t.protocolVersion } : {}),
      ...t.headers,
    },
    body: JSON.stringify(
      id === undefined
        ? { jsonrpc: '2.0', method, params } // notification
        : { jsonrpc: '2.0', id, method, params },
    ),
  });

  const newSession = resp.headers.get('mcp-session-id');
  if (newSession) {
    t.sessionId = newSession;
  }

  if (id === undefined) {
    return undefined; // notifications expect no body
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`MCP server ${resp.status}: ${detail}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  let payload: { result?: unknown; error?: { message?: string } };

  if (contentType.includes('text/event-stream')) {
    // Read the stream until we find the response frame for our id.
    const text = await resp.text();
    const frames = text.split('\n\n');
    let found: typeof payload | undefined;
    for (const frame of frames) {
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) {
        continue;
      }
      try {
        const parsed = JSON.parse(dataLine.slice(5).trim());
        if (parsed.id === id) {
          found = parsed;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!found) {
      throw new Error('MCP server returned an event stream without a response for the request.');
    }
    payload = found;
  } else {
    payload = await resp.json();
  }

  if (payload.error) {
    throw new Error(`MCP error: ${payload.error.message ?? 'unknown'}`);
  }
  return payload.result;
}

export class McpHttpClient {
  private t: Transport;
  private nextId = 1;
  private initialized = false;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.t = { url, headers };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const result = await rpc(this.t, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'artivio-command-center', version: '1.0.0' },
    }, this.nextId++) as { protocolVersion?: string } | undefined;
    this.t.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    await rpc(this.t, 'notifications/initialized');
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = await rpc(this.t, 'tools/list', {}, this.nextId++) as { tools?: McpTool[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.ensureInitialized();
    const result = await rpc(this.t, 'tools/call', { name, arguments: args }, this.nextId++) as McpCallResult;
    return result ?? { content: [{ type: 'text', text: '(empty result)' }] };
  }
}
