import type { AnthropicTool } from '@/libs/mcp/registry';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { currentTurn, turnAborted } from '@/libs/agent/turnContext';
import { checkSpend } from '@/libs/billing/meter';
import { db } from '@/libs/DB';
import { diviBuilds } from '@/models/Schema';
import { loadSiteDesign, saveSiteDesign } from './designStore';
import { compilePage, DesignSchema, PagePlanSchema, PATTERN_VERSION, PATTERNS } from './patterns';
import { htmlFrom, summariseRender } from './renderCheck';

type Call = (tool: string, args: Record<string, unknown>) => Promise<string>;
const KeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
export const BUILD_TOOL_NAMES = ['divi_patterns', 'divi_site_design', 'divi_build_draft', 'divi_build_status', 'divi_verify_draft'] as const;
export const BUILD_TOOL_DEFINITIONS: AnthropicTool[] = [
  { name: 'divi_site_design', description: 'Agency-only persistent brand styles for this connected site. No arguments reads; design saves a complete small style specification in Artivio, NOT Divi presets. Subsequent new page plans inherit it when design is omitted. Does not mutate WordPress or require preset setup.', input_schema: { type: 'object', properties: { design: z.toJSONSchema(DesignSchema) } } },
  { name: 'divi_patterns', description: 'Agency build: list native responsive page patterns. Presets are optional; provide a brand design once and fill section content, not Divi JSON. Patterns require live Visual Builder approval before production use.', input_schema: { type: 'object', properties: {} } },
  { name: 'divi_build_draft', description: 'Agency build: persist a compact plan and create ONE unpublished Divi draft with native patterns, validation, readback and structure check. Never publishes or overwrites existing pages. Reuse the SAME build_key on resume; uncertain creates require reconciliation, never blind retries. Get the actual Divi 5 builderVersion from site info once. All images must already be uploaded to this site. No preset bootstrap required.', input_schema: {
    type: 'object',
    properties: { build_key: { type: 'string' }, plan: z.toJSONSchema(PagePlanSchema), dry_run: { type: 'boolean' } },
    required: ['build_key', 'plan'],
  } },
  { name: 'divi_build_status', description: 'Read the durable draft receipt/design/plan. Optional reconcile_page_id binds an uncertain creation ONLY after WordPress readback proves an exact matching draft. Does not write to WordPress.', input_schema: { type: 'object', properties: { build_key: { type: 'string' }, reconcile_page_id: { type: 'integer', minimum: 1 } }, required: ['build_key'] } },
  { name: 'divi_verify_draft', description: 'Read back a saved draft and check rendered HTML structure at a page checkpoint. This is NOT browser or visual QA. Use the metered browser check_layout on an accessible staging URL, then inspect screenshots. Drafts must stay unpublished.', input_schema: { type: 'object', properties: { build_key: { type: 'string' } }, required: ['build_key'] } },
];

export function envelope(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
  if (parsed.ok === false || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error(`DiviOps ${parsed.error?.code ?? 'invalid_response'}: ${parsed.error?.message ?? 'No success data returned.'}`);
  }
  return parsed.data;
}

function contentOf(data: Record<string, unknown>): string | undefined {
  if (typeof data.content === 'string') {
    return data.content;
  }
  if (data.content && typeof data.content === 'object' && typeof (data.content as { raw?: unknown }).raw === 'string') {
    return (data.content as { raw: string }).raw;
  }
  return typeof data.post_content === 'string' ? data.post_content : undefined;
}

export function buildMatches(data: Record<string, unknown>, markup: string): boolean {
  return contentOf(data) === markup;
}

export async function runBuildTool(a: { tenantId: string; connectionId: string; target: string; tool: string; args: Record<string, unknown>; call: Call }): Promise<string> {
  const turn = currentTurn();
  if (!turn || turn.surface !== 'operator' || turn.tenantId !== a.tenantId) {
    throw new Error('Agency build tools are available only in the operator workspace, not client site chat.');
  }
  if (a.tool === 'divi_site_design') {
    const design = a.args.design === undefined
      ? await loadSiteDesign(a.tenantId, a.connectionId, a.target)
      : await saveSiteDesign(a.tenantId, a.connectionId, a.target, a.args.design);
    return JSON.stringify({ design: design ?? null, presetsRequired: false, wordPressWrites: 0 });
  }
  if (a.tool === 'divi_patterns') {
    return JSON.stringify({ version: PATTERN_VERSION, patterns: PATTERNS, presetsRequired: false, verification: 'schema-tested; live Divi/Visual Builder approval still required', designFields: ['primary', 'background', 'surface', 'heading', 'body', 'buttonText', 'font', 'contentWidth'] });
  }
  const key = KeySchema.parse(a.args.build_key);
  const where = and(eq(diviBuilds.tenantId, a.tenantId), eq(diviBuilds.connectionId, a.connectionId), eq(diviBuilds.buildKey, key));
  const read = async () => (await db.select().from(diviBuilds).where(where).limit(1))[0];
  let row = await read();
  if (row && row.target !== a.target) {
    throw new Error('Connection target changed. Use a new build key; never resume a receipt against another site.');
  }
  if (a.tool === 'divi_build_status') {
    if (a.args.reconcile_page_id !== undefined) {
      const id = z.number().int().positive().parse(a.args.reconcile_page_id);
      if (!row || row.pageId || !['creating', 'uncertain'].includes(row.status)) {
        throw new Error('Only an uncertain receipt without a page ID can be reconciled.');
      }
      const data = envelope(await a.call('diviops_page_get', { page_id: id }));
      const compiled = compilePage(row.plan, new URL(a.target).hostname);
      if (data.status !== 'draft' || !buildMatches(data, compiled.markup)) {
        throw new Error('Reconciliation refused: page is not an exact matching unpublished draft.');
      }
      await db.update(diviBuilds).set({ pageId: id, status: 'saved', updatedAt: new Date() }).where(and(where, eq(diviBuilds.status, row.status)));
      row = await read();
    }
    return JSON.stringify(row ? { buildKey: key, status: row.status, pageId: row.pageId, plan: row.plan, receipt: row.receipt } : { status: 'not_found' });
  }
  if (a.tool === 'divi_verify_draft') {
    if (!row?.pageId) {
      throw new Error('No saved page ID in this build receipt. Reconcile uncertain creation before verification.');
    }
    const data = envelope(await a.call('diviops_page_get', { page_id: row.pageId }));
    const html = htmlFrom(await a.call('diviops_render_preview', { page_id: row.pageId }));
    const compiled = compilePage(row.plan, new URL(a.target).hostname);
    if (data.status !== 'draft' || !buildMatches(data, compiled.markup)) {
      return JSON.stringify({ status: 'content_drift', pageId: row.pageId, action: 'Draft status/content changed; do not overwrite.' });
    }
    const status = html && /\bet_pb_module\b/.test(html) ? 'structure_checked' : 'saved';
    const receipt = { ...(row.receipt && typeof row.receipt === 'object' ? row.receipt : {}), pageStatus: data.status, structure: html ? summariseRender(html, new URL(a.target).hostname) : 'unavailable', browser: 'not_checked', visual: 'not_approved', checkedAt: new Date().toISOString() };
    await db.update(diviBuilds).set({ status, receipt, updatedAt: new Date() }).where(where);
    return JSON.stringify({ pageId: row.pageId, status, ...receipt });
  }
  if (a.tool !== 'divi_build_draft') {
    throw new Error('Unknown build tool.');
  }
  const input = a.args.plan && typeof a.args.plan === 'object' ? a.args.plan as Record<string, unknown> : {};
  // Existing receipts retain their design even if the site's defaults change.
  const inherited = input.design === undefined ? (row?.plan as { design?: unknown } | undefined)?.design ?? await loadSiteDesign(a.tenantId, a.connectionId, a.target) : input.design;
  const { plan, markup, stats } = compilePage({ ...input, ...(inherited ? { design: inherited } : {}) }, new URL(a.target).hostname);
  const hash = createHash('sha256').update(markup).digest('hex');
  if (a.args.dry_run === true) {
    return JSON.stringify({ status: 'planned', patterns: plan.sections.map(s => s.pattern), stats, hash, presetsRequired: false, writes: 0 });
  }
  if (row && JSON.stringify(row.plan) !== JSON.stringify(plan)) {
    // JSONB object key ordering is not stable; compare canonical compiled output.
    if (compilePage(row.plan, new URL(a.target).hostname).markup !== markup) {
      throw new Error('This build key belongs to a different plan. Use a new key; existing pages are never overwritten by this tool.');
    }
  }
  if (!row) {
    await db.insert(diviBuilds).values({ tenantId: a.tenantId, connectionId: a.connectionId, buildKey: key, target: a.target, plan }).onConflictDoNothing();
    row = await read();
    if (!row || compilePage(row.plan, new URL(a.target).hostname).markup !== markup) {
      throw new Error('Build key collision: reload the receipt before continuing.');
    }
  }
  if (row.pageId) {
    const data = envelope(await a.call('diviops_page_get', { page_id: row.pageId }));
    if (data.status !== 'draft' || !buildMatches(data, markup)) {
      return JSON.stringify({ status: 'content_drift', pageId: row.pageId, action: 'Manual review required; saved draft changed. Nothing overwritten.' });
    }
    return JSON.stringify({ status: row.status, pageId: row.pageId, receipt: row.receipt, reused: true });
  }
  if (row.status !== 'planned') {
    return JSON.stringify({ status: row.status, action: 'Creation may have succeeded. Inspect WordPress pages and reconcile the receipt; do not retry under a new key.', receipt: row.receipt });
  }
  const spend = await checkSpend(a.tenantId);
  if (!spend.allowed || turnAborted()) {
    throw new Error(spend.reason ?? 'Build stopped by the operator.');
  }
  // Compare-and-swap before the non-idempotent operation: concurrent turns cannot create twice.
  const claimed = await db.update(diviBuilds).set({ status: 'creating', receipt: { hash, startedAt: new Date().toISOString() }, updatedAt: new Date() }).where(and(where, eq(diviBuilds.status, 'planned'))).returning();
  if (!claimed.length) {
    return JSON.stringify({ status: 'creating', action: 'Another execution owns this build. Read status; do not retry.' });
  }
  let pageId: number | undefined;
  const started = Date.now();
  try {
    const created = envelope(await a.call('diviops_page_create', { title: plan.title, slug: plan.slug, status: 'draft', content: markup }));
    const id = Number(created.page_id ?? created.id ?? created.post_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('Creation returned no valid page ID; outcome is uncertain.');
    }
    pageId = id;
    await db.update(diviBuilds).set({ pageId, status: 'saved', receipt: { hash, stats, browser: 'not_checked', visual: 'not_approved' }, updatedAt: new Date() }).where(where);
    const saved = envelope(await a.call('diviops_page_get', { page_id: pageId }));
    if (saved.status !== 'draft' || !buildMatches(saved, markup)) {
      throw new Error('Draft readback did not match expected content/status; review required.');
    }
    // wp cache flush alone does not clear Divi's compiled on-disk CSS.
    envelope(await a.call('diviops_meta_flush_cache', { post_id: pageId }));
    const html = htmlFrom(await a.call('diviops_render_preview', { page_id: pageId }));
    const status = html && /\bet_pb_module\b/.test(html) ? 'structure_checked' : 'saved';
    const receipt = { hash, stats, patternVersion: PATTERN_VERSION, elapsedMs: Date.now() - started, wordPressCalls: 4, structure: html ? summariseRender(html, new URL(a.target).hostname) : 'unavailable', browser: 'not_checked', visual: 'not_approved', preview: `${a.target}/wp-admin/post.php?post=${pageId}&action=edit`, finishedAt: new Date().toISOString() };
    await db.update(diviBuilds).set({ status, receipt, updatedAt: new Date() }).where(where);
    return JSON.stringify({ status, pageId, ...receipt });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Build failed';
    const status = pageId ? 'review_required' : 'uncertain';
    await db.update(diviBuilds).set({ status, ...(pageId ? { pageId } : {}), receipt: { hash, error: message, action: 'Read back WordPress state before any retry. Never blindly recreate.', browser: 'not_checked' }, updatedAt: new Date() }).where(where);
    return JSON.stringify({ status, pageId, error: message, retrySafe: false });
  }
}
