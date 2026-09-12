/**
 * AI model catalog — platform admin CRUD (Phase 43).
 *
 * GET    /api/admin/models       — every model (active + inactive)
 * POST   /api/admin/models       — add a model (id = the exact Bedrock
 *                                  Mantle model id, used verbatim in calls)
 * PATCH  /api/admin/models       — update pricing/capability/active flag
 * DELETE /api/admin/models?id=   — remove a model from the catalog
 *
 * This is what lets Ryan add a newly-available Mantle model or reprice an
 * existing one without a code deploy — see model_catalog in Schema.ts and
 * migrations/0024_model_catalog.sql for the seeded rows and the
 * toolUseVerified caveat (false by default; flip it only after a real
 * mission test confirms tool-calling holds up for that model).
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/libs/auth/session';
import { db } from '@/libs/DB';
import { modelCatalog } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  id: z.string().min(1).max(120),
  provider: z.string().min(1).max(40),
  displayName: z.string().min(1).max(120),
  apiFormat: z.enum(['anthropic', 'openai']).default('anthropic'),
  inputPricePerM: z.number().min(0),
  outputPricePerM: z.number().min(0),
  contextWindow: z.number().int().min(0).optional(),
  maxOutputTokens: z.number().int().min(0).optional(),
  supportsReasoning: z.boolean().optional(),
  toolUseVerified: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});

const UpdateSchema = z.object({
  id: z.string().min(1).max(120),
  provider: z.string().min(1).max(40).optional(),
  displayName: z.string().min(1).max(120).optional(),
  apiFormat: z.enum(['anthropic', 'openai']).optional(),
  inputPricePerM: z.number().min(0).optional(),
  outputPricePerM: z.number().min(0).optional(),
  contextWindow: z.number().int().min(0).nullable().optional(),
  maxOutputTokens: z.number().int().min(0).nullable().optional(),
  supportsReasoning: z.boolean().optional(),
  toolUseVerified: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return null;
  }
  return user;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const rows = await db.select().from(modelCatalog).orderBy(modelCatalog.provider, modelCatalog.displayName);
  return NextResponse.json({ models: rows });
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid model.' }, { status: 400 });
  }
  const v = parsed.data;
  const [row] = await db
    .insert(modelCatalog)
    .values({
      id: v.id,
      provider: v.provider,
      displayName: v.displayName,
      apiFormat: v.apiFormat,
      inputPricePerM: String(v.inputPricePerM),
      outputPricePerM: String(v.outputPricePerM),
      contextWindow: v.contextWindow,
      maxOutputTokens: v.maxOutputTokens,
      supportsReasoning: v.supportsReasoning ?? false,
      // Never trust a caller's claim on creation — a model is only "verified"
      // after this platform has actually run a mission with it.
      toolUseVerified: false,
      notes: v.notes,
      active: v.active ?? true,
    })
    .onConflictDoNothing({ target: modelCatalog.id })
    .returning();

  if (!row) {
    return NextResponse.json({ error: `A model with id "${v.id}" already exists.` }, { status: 409 });
  }
  return NextResponse.json({ model: row });
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid update.' }, { status: 400 });
  }
  const { id, ...rest } = parsed.data;

  const [row] = await db
    .update(modelCatalog)
    .set({
      ...(rest.provider !== undefined ? { provider: rest.provider } : {}),
      ...(rest.displayName !== undefined ? { displayName: rest.displayName } : {}),
      ...(rest.apiFormat !== undefined ? { apiFormat: rest.apiFormat } : {}),
      ...(rest.inputPricePerM !== undefined ? { inputPricePerM: String(rest.inputPricePerM) } : {}),
      ...(rest.outputPricePerM !== undefined ? { outputPricePerM: String(rest.outputPricePerM) } : {}),
      ...(rest.contextWindow !== undefined ? { contextWindow: rest.contextWindow } : {}),
      ...(rest.maxOutputTokens !== undefined ? { maxOutputTokens: rest.maxOutputTokens } : {}),
      ...(rest.supportsReasoning !== undefined ? { supportsReasoning: rest.supportsReasoning } : {}),
      ...(rest.toolUseVerified !== undefined ? { toolUseVerified: rest.toolUseVerified } : {}),
      ...(rest.notes !== undefined ? { notes: rest.notes } : {}),
      ...(rest.active !== undefined ? { active: rest.active } : {}),
      updatedAt: new Date(),
    })
    .where(eq(modelCatalog.id, id))
    .returning();

  if (!row) {
    return NextResponse.json({ error: 'Model not found.' }, { status: 404 });
  }
  return NextResponse.json({ model: row });
}

export async function DELETE(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id required.' }, { status: 400 });
  }
  await db.delete(modelCatalog).where(eq(modelCatalog.id, id));
  return NextResponse.json({ ok: true });
}
