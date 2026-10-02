import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithTurnContext } from '@/libs/agent/turnContext';
import { compilePage } from './patterns';

const state = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined, claim: true, spend: true }));
vi.mock('@/libs/DB', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => state.row ? [state.row] : [] }) }) }),
  insert: () => ({ values: (v: Record<string, unknown>) => ({ onConflictDoNothing: async () => {
    state.row ??= { ...v, status: 'planned', pageId: null };
  } }) }),
  update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => {
    const apply = async () => {
      state.row = { ...state.row, ...v };
    };
    return { then: (resolve: (v: unknown) => void) => apply().then(resolve), returning: async () => {
      if (!state.claim) {
        return [];
      }
      await apply();
      return [state.row];
    } };
  } }) }),
} }));
vi.mock('@/libs/billing/meter', () => ({ checkSpend: async () => ({ allowed: state.spend, reason: 'cap reached' }) }));
vi.mock('./designStore', () => ({ loadSiteDesign: async () => undefined, saveSiteDesign: async (_t: string, _c: string, _url: string, design: unknown) => design }));
const { runBuildTool } = await import('./buildTools');
const plan = { title: 'Home', slug: 'home', builderVersion: '5.4.1', sections: [{ pattern: 'hero-centered', title: 'Welcome', body: 'Our community' }] };
const markup = compilePage(plan, 'example.com').markup;
const response = (data: unknown) => JSON.stringify({ ok: true, data });
const run = (tool: string, args: Record<string, unknown>, call = vi.fn()) => runWithTurnContext({ tenantId: 'tenant', conversationId: 'conv', surface: 'operator' }, async () => runBuildTool({ tenantId: 'tenant', connectionId: 'conn', target: 'https://example.com', tool, args, call }));

describe('draft pipeline receipts', () => {
  beforeEach(() => {
    state.row = undefined;
    state.claim = true;
    state.spend = true;
  });

  it('dry run validates without DB or WordPress writes', async () => {
    const call = vi.fn();
    const result = JSON.parse(await run('divi_build_draft', { build_key: 'home', plan, dry_run: true }, call));

    expect(result.writes).toBe(0);
    expect(state.row).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it('persists site design without creating Divi presets or WordPress writes', async () => {
    const call = vi.fn();
    const result = JSON.parse(await run('divi_site_design', { design: { primary: '#123456' } }, call));

    expect(result.wordPressWrites).toBe(0);
    expect(result.presetsRequired).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('creates a draft once, verifies readback, and reuses it on resume', async () => {
    const call = vi.fn(async (tool: string) => tool === 'diviops_page_create' ? response({ id: 7 }) : tool === 'diviops_page_get' ? response({ status: 'draft', content: markup }) : response({ html: '<div class="et_pb_section"><div class="et_pb_module">Welcome</div></div>' }));
    const result = JSON.parse(await run('divi_build_draft', { build_key: 'home', plan }, call));

    expect(result.status).toBe('structure_checked');
    expect(result.browser).toBe('not_checked');
    expect(call.mock.calls[0]).toEqual(['diviops_page_create', expect.objectContaining({ status: 'draft', content: markup })]);
    expect(JSON.parse(await run('divi_build_draft', { build_key: 'home', plan }, call)).reused).toBe(true);
    expect(call.mock.calls.filter(c => c[0] === 'diviops_page_create')).toHaveLength(1);
  });

  it('an uncertain create is never blindly replayed and can be reconciled by exact draft readback', async () => {
    const call = vi.fn().mockRejectedValue(new Error('timed out'));

    expect(JSON.parse(await run('divi_build_draft', { build_key: 'home', plan }, call)).status).toBe('uncertain');

    await run('divi_build_draft', { build_key: 'home', plan }, call);

    expect(call).toHaveBeenCalledTimes(1);

    const read = vi.fn().mockResolvedValue(response({ status: 'draft', content: markup }));

    expect(JSON.parse(await run('divi_build_status', { build_key: 'home', reconcile_page_id: 7 }, read)).pageId).toBe(7);
  });

  it('invalid creation ID stays uncertain, never writes NaN into the receipt', async () => {
    const call = vi.fn().mockResolvedValue(response({ title: 'Home' }));
    const result = JSON.parse(await run('divi_build_draft', { build_key: 'home', plan }, call));

    expect(result.status).toBe('uncertain');
    expect(state.row?.pageId).toBeNull();
  });

  it('does not create when another execution owns the claim or spend is blocked', async () => {
    state.claim = false;
    const call = vi.fn();

    expect(JSON.parse(await run('divi_build_draft', { build_key: 'home', plan }, call)).status).toBe('creating');
    expect(call).not.toHaveBeenCalled();

    state.row = undefined;
    state.spend = false;

    await expect(run('divi_build_draft', { build_key: 'home', plan }, call)).rejects.toThrow('cap reached');
  });

  it('refuses cross-target resume, plan changes and client chat access', async () => {
    state.row = { target: 'https://other.com', plan, status: 'uncertain' };

    await expect(run('divi_build_status', { build_key: 'home' })).rejects.toThrow('target changed');

    state.row = { target: 'https://example.com', plan, status: 'uncertain' };

    await expect(run('divi_build_draft', { build_key: 'home', plan: { ...plan, sections: [{ pattern: 'cta', title: 'Different' }] } })).rejects.toThrow('different plan');
    await expect(runWithTurnContext({ tenantId: 'tenant', conversationId: 'conv', surface: 'site' }, async () => runBuildTool({ tenantId: 'tenant', connectionId: 'conn', target: 'https://example.com', tool: 'divi_patterns', args: {}, call: vi.fn() }))).rejects.toThrow('operator workspace');
  });
});
