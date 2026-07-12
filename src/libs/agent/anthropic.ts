/**
 * Multi-provider Claude transport (no SDK deps) — same pattern proven in the
 * BudgetSmart marketing repo. First configured provider wins:
 *   1. BEDROCK_API_KEY  — Bedrock bearer-token invoke (non-streaming; the
 *      reply is yielded in one chunk).
 *   2. ANTHROPIC_API_KEY / CLAUDE_API_KEY — api.anthropic.com with true
 *      token-by-token streaming.
 */

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/** Content-block message shape for tool-use turns. */
export type BlockMessage = { role: 'user' | 'assistant'; content: unknown };

export type RawModelResponse = {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string;
};

const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-6';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

function bedrockRegion(): string {
  return process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
}

async function callBedrockBearer(a: {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
}): Promise<string> {
  const key = process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
  const url = `https://bedrock-runtime.${bedrockRegion()}.amazonaws.com/model/${encodeURIComponent(BEDROCK_MODEL)}/invoke`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: a.maxTokens,
      system: a.system,
      messages: a.messages,
    }),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Bedrock ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  return data.content?.find((c: { type: string }) => c.type === 'text')?.text || '';
}

async function* streamAnthropicDirect(a: {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
}): AsyncGenerator<string> {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key || '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: a.maxTokens,
      system: a.system,
      messages: a.messages,
      stream: true,
    }),
  });

  if (!resp.ok || !resp.body) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Anthropic ${resp.status}: ${detail}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) {
        continue;
      }
      try {
        const event = JSON.parse(dataLine.slice(5).trim());
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield event.delta.text as string;
        }
        if (event.type === 'error') {
          throw new Error(event.error?.message || 'Anthropic stream error');
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          continue; // partial/non-JSON frame — ignore
        }
        throw err;
      }
    }
  }
}

/**
 * Tool-capable single model call (non-streaming) via the Bedrock bearer
 * endpoint — used by the agent tool loop. Falls back to api.anthropic.com
 * when only an Anthropic key is configured.
 */
export async function callClaudeWithTools(a: {
  system: string;
  messages: BlockMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxTokens?: number;
}): Promise<RawModelResponse> {
  const maxTokens = a.maxTokens ?? 4096;
  const wantsBedrockBearer = Boolean(process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK);
  const wantsAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);

  if (wantsBedrockBearer) {
    const key = process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
    const url = `https://bedrock-runtime.${bedrockRegion()}.amazonaws.com/model/${encodeURIComponent(BEDROCK_MODEL)}/invoke`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: a.system,
        messages: a.messages,
        ...(a.tools.length > 0 ? { tools: a.tools } : {}),
      }),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      throw new Error(`Bedrock ${resp.status}: ${detail}`);
    }
    return await resp.json() as RawModelResponse;
  }

  if (wantsAnthropic) {
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: a.system,
        messages: a.messages,
        ...(a.tools.length > 0 ? { tools: a.tools } : {}),
      }),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      throw new Error(`Anthropic ${resp.status}: ${detail}`);
    }
    return await resp.json() as RawModelResponse;
  }

  throw new Error(
    'No AI credentials configured. Add ONE of these to the Railway variables: '
    + 'BEDROCK_API_KEY (+ optional BEDROCK_REGION/BEDROCK_MODEL_ID) or ANTHROPIC_API_KEY.',
  );
}

export async function* streamClaude(a: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): AsyncGenerator<string> {
  const maxTokens = a.maxTokens ?? 4096;
  const wantsBedrockBearer = Boolean(process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK);
  const wantsAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);

  if (wantsBedrockBearer) {
    yield await callBedrockBearer({ system: a.system, messages: a.messages, maxTokens });
    return;
  }
  if (wantsAnthropic) {
    yield* streamAnthropicDirect({ system: a.system, messages: a.messages, maxTokens });
    return;
  }

  throw new Error(
    'No AI credentials configured. Add ONE of these to the Railway variables: '
    + 'BEDROCK_API_KEY (+ optional BEDROCK_REGION/BEDROCK_MODEL_ID) or ANTHROPIC_API_KEY.',
  );
}
