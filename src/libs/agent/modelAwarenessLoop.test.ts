import { describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/DB', () => ({ db: { insert: () => ({ values: () => Promise.resolve() }) } }));
vi.mock('@/libs/billing/meter', () => ({ checkSpend: async () => ({ allowed: true }), meterLlm: vi.fn() }));
vi.mock('./modelConfig', () => ({ resolveModelConfig: async () => ({ modelId: 'deepseek.v3.2', selectionSource: 'workspace', reasoningEffort: 'high' }) }));
vi.mock('./modelIdentity', async () => {
  const original = await vi.importActual<typeof import('./modelIdentity')>('./modelIdentity');
  return { ...original, loadModelIdentity: async (config: Parameters<typeof original.makeModelIdentity>[0], context: 'chat' | 'build') => original.makeModelIdentity(config, context, { displayName: 'DeepSeek V3.2', supportsReasoning: false }) };
});
const { runToolLoop } = await import('./loop');

describe('model awareness across agent surfaces', () => {
  it.each(['operator', 'site'] as const)('exposes real response metadata through get_model_info on %s', async (surface) => {
    vi.stubEnv('BEDROCK_MANTLE_API_KEY', 'test');
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: 'deepseek.v3.2', choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'get_model_info', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'x-request-id': 'request-proof' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: 'deepseek.v3.2', choices: [{ message: { content: 'DeepSeek V3.2 is the requested and provider-reported model.' }, finish_reason: 'stop' }] })));
    vi.stubGlobal('fetch', fetch);
    try {
      const result = await runToolLoop({ tenantId: 'tenant', conversationId: 'conv', surface, modelContext: surface === 'site' ? 'build' : undefined, system: 'You are Noah.', history: [], userText: 'Which model are you using?', toolset: { anthropicTools: [], resolve: () => null, failedConnections: [], deferredSummary: '', connectionGuidance: '', attachToolSink: () => {} }, onDelta: () => {} });
      const first = JSON.parse(fetch.mock.calls[0]![1].body);

      expect(first.model).toBe('deepseek.v3.2');
      expect(first).not.toHaveProperty('reasoning_effort');
      expect(first.tools.some((t: { function: { name: string } }) => t.function.name === 'get_model_info')).toBe(true);
      expect(first.messages[0].content).toContain('Current model routing');

      const second = JSON.parse(fetch.mock.calls[1]![1].body);
      const toolResult = second.messages.find((m: { role: string }) => m.role === 'tool');

      expect(toolResult.content).toContain('request-proof');
      expect(toolResult.content).toContain('"providerReportedModelId":"deepseek.v3.2"');
      expect(result.text).toContain('[model]');
      expect(result.text).toContain(surface === 'site' ? 'build · assigned' : 'chat · assigned');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
