/**
 * GET  /api/mcp/connections?tenant=<slug> — list the tenant's MCP connections
 * POST /api/mcp/connections — create one; credential VALUES are sealed into
 * the vault immediately and never returned. Owners/admins only.
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { getUserTenants } from '@/libs/tenants';
import { sealSecret, vaultConfigured } from '@/libs/vault';
import { auditLog, credentials, mcpConnections } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = ['owner', 'admin'];

async function requireManagedTenant(userId: string, isAdmin: boolean, slug: string) {
  const tenant = (await getUserTenants(userId)).find(t => t.slug === slug);
  if (!tenant) {
    return null;
  }
  if (!isAdmin && !MANAGER_ROLES.includes(tenant.role)) {
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

  const rows = await db
    .select({
      id: mcpConnections.id,
      name: mcpConnections.name,
      transport: mcpConnections.transport,
      url: mcpConnections.url,
      toolPolicy: mcpConnections.toolPolicy,
      enabled: mcpConnections.enabled,
      createdAt: mcpConnections.createdAt,
    })
    .from(mcpConnections)
    .where(eq(mcpConnections.tenantId, tenant.id));

  return NextResponse.json({ connections: rows, vaultConfigured: vaultConfigured() });
}

const CreateSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  name: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/i, 'Letters, numbers and dashes only'),
  url: z.string().url().max(2000),
  // header name → secret value (e.g. { "Authorization": "Bearer sk_..." }).
  // Values are sealed into the vault; only credential IDs are stored on the
  // connection.
  headers: z.record(z.string().min(1).max(100), z.string().min(1).max(4000)).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const tenant = await requireManagedTenant(user.id, user.isAdmin, body.tenantSlug);
  if (!tenant) {
    return NextResponse.json({ error: 'You need owner/admin access to manage tools.' }, { status: 403 });
  }

  const headerEntries = Object.entries(body.headers ?? {});
  if (headerEntries.length > 0 && !vaultConfigured()) {
    return NextResponse.json(
      { error: 'Credential vault is not configured (VAULT_MASTER_KEY missing). Add it to the Railway variables first.' },
      { status: 500 },
    );
  }

  const headerCredentials: Record<string, string> = {};
  for (const [header, value] of headerEntries) {
    const [cred] = await db
      .insert(credentials)
      .values({
        tenantId: tenant.id,
        provider: body.name,
        label: `${body.name} · ${header}`.slice(0, 120), // column is varchar(120)
        cipher: sealSecret(value),
      })
      .returning({ id: credentials.id });
    if (cred) {
      headerCredentials[header] = cred.id;
    }
  }

  const [connection] = await db
    .insert(mcpConnections)
    .values({
      tenantId: tenant.id,
      name: body.name.toLowerCase(),
      transport: 'http',
      url: body.url,
      headerCredentials,
      toolPolicy: {}, // everything defaults to 'approval' until configured
    })
    .returning({ id: mcpConnections.id, name: mcpConnections.name });

  await db.insert(auditLog).values({
    tenantId: tenant.id,
    actor: user.id,
    action: 'connection.create',
    target: connection?.name ?? body.name,
  }).catch(() => {});

  return NextResponse.json({ ok: true, connection });
}
