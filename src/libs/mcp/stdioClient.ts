/**
 * MCP over stdio — JSON-RPC 2.0 to a SPAWNED child process instead of a URL.
 *
 * This is the "Phase 4" transport client.ts promised. Most of the MCP
 * ecosystem ships stdio-only servers (built for Claude Code / Cursor running
 * locally), and Artivio could not reach any of them. stdio does NOT mean
 * "local-only" — it means "spawned process": those servers run fine on the
 * Railway container as long as something owns the process. This module is
 * that something.
 *
 * 🔴 SECURITY INVARIANT — never weaken this:
 * The command that gets spawned NEVER comes from user input, a connection row,
 * or a catalog URL field. It comes exclusively from STDIO_SERVERS in
 * stdioCatalog.ts — a hardcoded allowlist of npm packages bundled as
 * dependencies of this app. A connection only names an allowlist KEY. Anything
 * else would make "add an MCP connection" into remote code execution.
 *
 * Framing: MCP stdio = one JSON-RPC message per line (newline-delimited JSON,
 * UTF-8). NOT LSP-style Content-Length headers.
 *
 * Lifecycle: processes are pooled per (connection, credential fingerprint)
 * and reaped after IDLE_TTL_MS of silence, so a chat burst reuses one process
 * instead of paying spawn+init per message, and a rotated credential gets a
 * fresh process instead of a stale one.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export type StdioTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type StdioCallResult = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
};

const PROTOCOL_VERSION = '2025-03-26';
const LIST_TIMEOUT_MS = 20_000; // spawn + server init + tools/list
const CALL_TIMEOUT_MS = 120_000;
const IDLE_TTL_MS = 5 * 60_000;
const MAX_POOL = 8;
const MAX_STDERR_KEEP = 2_048;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = '';
  private stderrTail = '';
  private initialized: Promise<void> | null = null;
  private dead = false;

  constructor(
    private readonly entryPath: string,
    private readonly env: Record<string, string>,
    private readonly label: string,
  ) {}

  get alive(): boolean {
    return !this.dead && this.child !== null && this.child.exitCode === null;
  }

  private start(): void {
    // Minimal, deliberate environment. NEVER ...process.env — this process
    // holds DB credentials, the vault master key, and platform API keys that
    // a third-party MCP server has no business seeing.
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...this.env,
    };
    // process.execPath = the exact Node binary running this app — no PATH
    // lookup, no npx, no network at spawn time.
    const child = spawn(process.execPath, [this.entryPath], {
      // childEnv is a plain Record, but it always sets NODE_ENV above; cast so
      // it satisfies Node's ProcessEnv type (which now requires NODE_ENV).
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_KEEP);
    });
    child.on('error', err => this.failAll(new Error(`${this.label}: failed to start (${err.message})`)));
    child.on('exit', (code, signal) => {
      this.dead = true;
      this.failAll(new Error(
        `${this.label}: server exited (${signal ?? `code ${code}`}). ${this.stderrTail ? `stderr: ${this.stderrTail.slice(-300)}` : ''}`.trim(),
      ));
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    // One JSON-RPC message per line. A server may also print non-JSON noise —
    // skip lines that don't parse rather than dying on them.
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.error) {
                p.reject(new Error(`${this.label}: ${msg.error.message ?? 'unknown MCP error'}`));
              } else {
                p.resolve(msg.result);
              }
            }
          }
          // Requests/notifications FROM the server (logging, sampling…) are
          // ignored — this client doesn't offer those capabilities.
        } catch {
          // Non-JSON stdout line: tolerated, ignored.
        }
      }
      nl = this.buf.indexOf('\n');
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.child || !this.alive) {
      throw new Error(`${this.label}: server is not running.`);
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rpc(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        this.start();
        await this.rpc('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'artivio-command-center', version: '1.0.0' },
        }, LIST_TIMEOUT_MS);
        this.notify('notifications/initialized');
      })();
      // A failed init must not be cached as "initialized" forever.
      this.initialized.catch(() => {
        this.initialized = null;
        this.dispose();
      });
    }
    return this.initialized;
  }

  async listTools(): Promise<StdioTool[]> {
    await this.ensureInitialized();
    const result = await this.rpc('tools/list', {}, LIST_TIMEOUT_MS) as { tools?: StdioTool[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<StdioCallResult> {
    await this.ensureInitialized();
    const result = await this.rpc('tools/call', { name, arguments: args }) as StdioCallResult;
    return result ?? { content: [{ type: 'text', text: '(empty result)' }] };
  }

  dispose(): void {
    this.dead = true;
    this.failAll(new Error(`${this.label}: client disposed.`));
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      // Escalate if it ignores SIGTERM.
      const c = this.child;
      setTimeout(() => {
        if (c.exitCode === null) {
          c.kill('SIGKILL');
        }
      }, 3_000).unref();
    }
    this.child = null;
  }
}

// ─── Process pool ────────────────────────────────────────────────────────────
// Keyed by connection id + a fingerprint of (entry, env), so rotating the
// credential or editing the target retires the old process automatically.

type PoolEntry = { client: McpStdioClient; lastUsed: number };
const pool = new Map<string, PoolEntry>();
let reaper: NodeJS.Timeout | null = null;

function fingerprint(entryPath: string, env: Record<string, string>): string {
  const h = createHash('sha256');
  h.update(entryPath);
  for (const k of Object.keys(env).sort()) {
    h.update(`\0${k}\0${env[k]}`);
  }
  return h.digest('hex').slice(0, 16);
}

function ensureReaper(): void {
  if (reaper) {
    return;
  }
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (now - entry.lastUsed > IDLE_TTL_MS || !entry.client.alive) {
        entry.client.dispose();
        pool.delete(key);
      }
    }
  }, 60_000);
  reaper.unref(); // never keep the server process alive just to reap
}

/**
 * Get (or spawn) the pooled client for a connection. `label` is used in error
 * messages the agent sees, so pass the connection name.
 */
export function acquireStdioClient(
  connectionId: string,
  entryPath: string,
  env: Record<string, string>,
  label: string,
): McpStdioClient {
  ensureReaper();
  const key = `${connectionId}:${fingerprint(entryPath, env)}`;
  const existing = pool.get(key);
  if (existing && existing.client.alive) {
    existing.lastUsed = Date.now();
    return existing.client;
  }
  if (existing) {
    existing.client.dispose();
    pool.delete(key);
  }
  // Bound the pool: evict the least-recently-used when full.
  if (pool.size >= MAX_POOL) {
    let lruKey: string | null = null;
    let lruAt = Infinity;
    for (const [k, e] of pool) {
      if (e.lastUsed < lruAt) {
        lruAt = e.lastUsed;
        lruKey = k;
      }
    }
    if (lruKey) {
      pool.get(lruKey)?.client.dispose();
      pool.delete(lruKey);
    }
  }
  const client = new McpStdioClient(entryPath, env, label);
  pool.set(key, { client, lastUsed: Date.now() });
  return client;
}

/** A throwaway, unpooled client — used by /api/mcp/test to verify credentials. */
export function createEphemeralStdioClient(
  entryPath: string,
  env: Record<string, string>,
  label: string,
): McpStdioClient {
  return new McpStdioClient(entryPath, env, label);
}
