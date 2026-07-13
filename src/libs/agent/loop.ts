/**
 * Agent tool loop with permission gateway.
 *
 * Flow per turn: build the tenant's toolset from enabled MCP connections →
 * call Claude with tools → on tool_use, consult the connection's toolPolicy:
 *   'auto'      → call the MCP server now, feed the result back
 *   'approval'  → insert an approvals row; tell the model it's queued
 *   'deny'      → tell the model the tool is not permitted
 * Every tool decision writes an audit_log row. Max 8 iterations per turn.
 */

import type { BlockMessage, ChatMessage } from '@/libs/agent/anthropic';
import type { TenantToolset } from '@/libs/mcp/registry';
import { callClaudeWithTools } from '@/libs/agent/anthropic';
import { db } from '@/libs/DB';
import { approvals, auditLog } from '@/models/Schema';

const MAX_ITERATIONS = 8;

export async function runToolLoop(a: {
  tenantId: string;
  conversationId: string;
  system: string;
  history: ChatMessage[];
  userText: string;
  toolset: TenantToolset;
  /** Called with displayable progress (text deltas + tool status lines). */
  onDelta: (text: string) => void;
}): Promise<string> {
  const messages: BlockMessage[] = [
    ...a.history.map(m => ({ role: m.role, content: m.content as unknown })),
    { role: 'user' as const, content: a.userText },
  ];

  let finalText = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callClaudeWithTools({
      system: a.system,
      messages,
      tools: a.toolset.anthropicTools,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    for (const block of textBlocks) {
      if (block.text) {
        finalText += (finalText ? '\n' : '') + block.text;
        a.onDelta(block.text);
      }
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: unknown[] = [];
    for (const use of toolUses) {
      const name = use.name ?? '';
      const args = use.input ?? {};
      const resolved = a.toolset.resolve(name);

      let resultText: string;
      let isError = false;

      if (!resolved) {
        resultText = `Unknown tool: ${name}`;
        isError = true;
      } else if (resolved.policy === 'deny') {
        resultText = 'This tool is not permitted in this workspace (policy: deny).';
        isError = true;
        await audit(a.tenantId, 'tool.denied', name, { args });
      } else if (resolved.policy === 'approval') {
        const [row] = await db
          .insert(approvals)
          .values({
            tenantId: a.tenantId,
            conversationId: a.conversationId || null,
            connectionId: resolved.connectionId || null,
            toolName: name,
            args,
          })
          .returning();
        a.onDelta(`\n\n[approval] ${name} queued for human approval (#${row?.id?.slice(0, 8)}).\n`);
        resultText = 'This action requires human approval and has been queued in the Approvals inbox. '
          + 'Tell the user it is awaiting their approval; the result will appear in the inbox once decided. '
          + 'Do not retry the same call.';
        await audit(a.tenantId, 'tool.queued_approval', name, { args, approvalId: row?.id });
      } else {
        a.onDelta(`\n\n[tool] calling ${name}…\n`);
        try {
          resultText = await resolved.call(args as Record<string, unknown>);
          await audit(a.tenantId, 'tool.call', name, { args, ok: true });
        } catch (err) {
          resultText = `Tool failed: ${err instanceof Error ? err.message : 'unknown error'}`;
          isError = true;
          await audit(a.tenantId, 'tool.call', name, { args, ok: false, error: resultText.slice(0, 300) });
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: resultText,
        ...(isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return finalText;
}

async function audit(tenantId: string, action: string, target: string, detail: unknown): Promise<void> {
  await db
    .insert(auditLog)
    .values({ tenantId, actor: 'agent', action, target, detail })
    .catch(() => {});
}
