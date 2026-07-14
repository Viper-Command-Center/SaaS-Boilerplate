/**
 * POST /api/mcp/test — health-check a hosted MCP server.
 *
 * Two modes:
 *   { url, headerName?, headerValue? }  → test BEFORE saving (add-time check)
 *   { connectionId }                    → re-test an existing connection
 *
 * This is the cheapest bug-prevention in the platform: most "the agent says the
 * tool is broken" reports are a wrong URL or a bad key, and the user finds out
 * mid-conversation. Testing at add time turns that into an immediate, honest
 * error next to the field that caused it.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { McpHttpClient } from '@/libs/mcp/client';
import { applyUrlSecret } from '@/libs/mcp/registry';
import { classifyToolError } from '@/libs/support/issues';
import { getUserTenants } from '@/libs/tenants';
import { openSecret } from '@/libs/vault';
import { credentials, mcpConnections } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MANAGER_ROLES = ['owner', 'admin'];

const BodySchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  connectionId: z.string().uuid().optional(),
  url: z.string().url().max(2000).optional(),
  headerName: z.string().max(80).optional(),
  headerValue: z.string().max(4000).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const tenant = (await getUserTenants(user.id)).find(t => t.slug === body.tenantSlug);
  if (!tenant || (!user.isAdmin && !MANAGER_ROLES.includes(tenant.role))) {
    return NextResponse.json({ error: 'You need owner/admin access.' }, { status: 403 });
  }

  // Resolve what we're testing: a saved connection, or an unsaved candidate.
  let url = body.url ?? '';
  let headers: Record<string, string> = {};

  if (body.headerName && body.headerValue) {
    headers[body.headerName] = body.headerValue;
  }

  if (body.connectionId) {
    const [conn] = await db
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.id, body.connectionId), eq(mcpConnections.tenantId, tenant.id)))
      .limit(1);

    if (!conn) {
      return NextResponse.json({ error: 'Connection not found.' }, { status: 404 });
    }
    if (conn.transport !== 'http' || !conn.url) {
      // Built-in providers have no endpoint to probe; they either have a
      // credential or they don't.
      return NextResponse.json({
        ok: true,
        builtin: true,
        message: 'Built-in plugin — no endpoint to test. It runs in-process.',
      });
    }

    url = conn.url;
    const map = (conn.headerCredentials ?? {}) as Record<string, string>;
    const ids = Object.values(map).filter(Boolean);
    if (ids.length > 0) {
      const rows = await db
        .select({ id: credentials.id, cipher: credentials.cipher })
        .from(credentials)
        .where(inArray(credentials.id, ids));
      const byId = new Map(rows.map(r => [r.id, r.cipher]));
      headers = {};
      for (const [header, credId] of Object.entries(map)) {
        const cipher = byId.get(credId);
        if (cipher) {
          headers[header] = openSecret(cipher);
        }
      }
    }
  }

  if (!url) {
    return NextResponse.json({ error: 'No URL to test.' }, { status: 400 });
  }

  try {
    // Vendors that carry the key in the URL path (Firecrawl) keep it in the
    // vault under the reserved `url` name; substitute it in memory here too.
    const resolved = applyUrlSecret(url, headers);
    const client = new McpHttpClient(resolved.url, resolved.headers);
    const tools = await client.listTools();
    return NextResponse.json({
      ok: true,
      toolCount: tools.length,
      tools: tools.slice(0, 25).map(t => t.name),
      message: tools.length === 0
        ? 'Connected, but the server reported no tools. Check you used the right endpoint path.'
        : `Connected. ${tools.length} tool(s) available.`,
    });
  } catch (err) {
    // Say what actually went wrong and who can fix it — never a generic failure.
    const triaged = classifyToolError(err);
    return NextResponse.json({
      ok: false,
      kind: triaged.kind,
      error: err instanceof Error ? err.message : 'Could not reach the server.',
      guidance: triaged.clientMessage,
    });
  }
}
