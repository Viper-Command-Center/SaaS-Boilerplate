/**
 * Direct Anthropic Messages API transport (no SDK dependency) — same pattern
 * proven in the BudgetSmart marketing repo. Streaming variant: yields text
 * deltas as they arrive.
 */

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

export async function* streamClaude(a: {
  system: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
}): AsyncGenerator<string> {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not configured on this service. Add it to the Railway variables.');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: a.model || DEFAULT_MODEL,
      max_tokens: a.maxTokens ?? 4096,
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

    // Anthropic streams SSE frames separated by double newlines.
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
