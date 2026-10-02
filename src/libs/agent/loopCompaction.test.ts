import type { BlockMessage } from './anthropic';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/DB', () => ({ db: {} }));
const { compactOldWritePayloads } = await import('./loop');

describe('historical Divi payload compaction', () => {
  it('keeps call IDs, recent arguments and ordinary tool input intact', () => {
    const messages: BlockMessage[] = Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `id-${i}`, name: 'mcp__divi__diviops-page-create', input: { title: 'Home', content: 'x'.repeat(6000) } }] }));
    compactOldWritePayloads(messages);
    const first = (messages[0]!.content as Array<{ id: string; input: { content: string; title: string } }>)[0]!;

    expect(first.id).toBe('id-0');
    expect(first.input.title).toBe('Home');
    expect(first.input.content).toContain('historical write payload elided');

    const last = (messages[7]!.content as Array<{ input: { content: string } }>)[0]!;

    expect(last.input.content).toHaveLength(6000);
  });
});
