import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, fail: false }));
vi.mock('@/libs/DB', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => {
  if (state.fail) {
    throw new Error('database unavailable');
  }
  return [{ settings: state.settings }];
} }) }) }) } }));
const { resolveModelConfig } = await import('./modelConfig');

describe('workspace model assignment', () => {
  it('reads chat and build independently and sees updates on the next resolution', async () => {
    state.fail = false;
    state.settings = { aiModels: { chatModelId: 'deepseek.v3.2', buildModelId: 'moonshotai.kimi-k2.5' } };

    expect((await resolveModelConfig('tenant', 'chat')).modelId).toBe('deepseek.v3.2');
    expect((await resolveModelConfig('tenant', 'build')).modelId).toBe('moonshotai.kimi-k2.5');

    state.settings = { aiModels: { chatModelId: 'anthropic.claude-haiku-4-5' } };

    expect((await resolveModelConfig('tenant', 'chat')).modelId).toBe('anthropic.claude-haiku-4-5');
    expect((await resolveModelConfig('tenant', 'build')).selectionSource).toBe('platform-default');
  });

  it('labels database failure fallback instead of pretending assignment was read', async () => {
    state.fail = true;

    expect((await resolveModelConfig('tenant', 'chat')).selectionSource).toBe('lookup-fallback');

    state.fail = false;
  });
});
