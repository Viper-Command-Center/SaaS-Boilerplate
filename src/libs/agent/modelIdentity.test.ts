import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/DB', () => ({ db: {} }));
const { makeModelIdentity, recordModelResponse, modelReceipt, modelIdentityPrompt } = await import('./modelIdentity');
const { callClaudeWithTools, resolveModelTransport } = await import('./anthropic');

const keys = ['BEDROCK_MANTLE_API_KEY', 'BEDROCK_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];
function credentials(mantle: boolean) {
  for (const key of keys) {
    vi.stubEnv(key, '');
  }
  if (mantle) {
    vi.stubEnv('BEDROCK_MANTLE_API_KEY', 'test-key');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('platform model identity', () => {
  it('names DeepSeek from resolved config, suppresses unsupported reasoning, and does not invent provider proof', () => {
    credentials(true);
    const identity = makeModelIdentity({ modelId: 'deepseek.v3.2', reasoningEffort: 'high', selectionSource: 'workspace' }, 'build', { displayName: 'DeepSeek V3.2', supportsReasoning: false });

    expect(identity.displayName).toBe('DeepSeek V3.2');
    expect(identity.requestedModelId).toBe('deepseek.v3.2');
    expect(identity.workspaceSelectionApplied).toBe(true);
    expect(identity.sentReasoningEffort).toBeNull();
    expect(identity.providerReportedModelId).toBeNull();
    expect(modelIdentityPrompt(identity)).toContain('Assigned/requested is NOT the same');
    expect(modelReceipt(identity)).toContain('provider-reported: not supplied');
  });

  it('warns when legacy routing ignores the workspace dropdown', () => {
    credentials(false);
    vi.stubEnv('BEDROCK_API_KEY', 'legacy');
    const identity = makeModelIdentity({ modelId: 'deepseek.v3.2' }, 'chat');

    expect(identity.transport).toBe('bedrock-runtime');
    expect(identity.requestedModelId).not.toBe('deepseek.v3.2');
    expect(identity.workspaceSelectionApplied).toBe(false);
    expect(identity.warning).toContain('NOT applied');
  });

  it('records provider-reported aliases/mismatches without claiming they equal the request', () => {
    credentials(true);
    const identity = makeModelIdentity({ modelId: 'deepseek.v3.2' }, 'chat');
    recordModelResponse(identity, { content: [], stop_reason: 'end_turn', _modelId: 'deepseek.v3.2', _providerModelId: 'deepseek-v3.2-2026', _requestId: 'request-123' });

    expect(identity.providerModelMatchesRequest).toBe(false);
    expect(modelReceipt(identity)).toContain('request-123');

    recordModelResponse(identity, { content: [], stop_reason: 'end_turn', _modelId: 'deepseek.v3.2' });

    expect(identity.providerModelMatchesRequest).toBeNull();
    expect(identity.providerReportedModelId).toBeNull();
  });

  it('reports lookup fallback and no-credentials cases honestly', () => {
    credentials(false);

    expect(resolveModelTransport('deepseek.v3.2').transport).toBe('unconfigured');
    expect(makeModelIdentity({ modelId: 'default', selectionSource: 'lookup-fallback' }, 'chat').warning).toContain('lookup failed');
  });
});

describe('real transport request / response metadata (mocked HTTP)', () => {
  it('sends the selected DeepSeek ID and preserves provider model and request ID', async () => {
    credentials(true);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'deepseek.v3.2', choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { headers: { 'x-request-id': 'req-deepseek' } }));
    vi.stubGlobal('fetch', fetch);
    const response = await callClaudeWithTools({ modelId: 'deepseek.v3.2', system: 'Test', messages: [{ role: 'user', content: 'Hello' }], tools: [] });
    const sent = JSON.parse(fetch.mock.calls[0]![1].body);

    expect(sent.model).toBe('deepseek.v3.2');
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(response._modelId).toBe('deepseek.v3.2');
    expect(response._providerModelId).toBe('deepseek.v3.2');
    expect(response._requestId).toBe('req-deepseek');
    expect(response.usage?.input_tokens).toBe(12);
  });

  it('preserves native Anthropic response metadata too', async () => {
    credentials(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'claude-sonnet-provider', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }), { headers: { 'request-id': 'req-claude' } })));
    const response = await callClaudeWithTools({ modelId: 'anthropic.claude-sonnet-5', system: 'Test', messages: [], tools: [] });

    expect(response._modelId).toBe('anthropic.claude-sonnet-5');
    expect(response._providerModelId).toBe('claude-sonnet-provider');
    expect(response._requestId).toBe('req-claude');
  });
});
