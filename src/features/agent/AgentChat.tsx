'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * Phase 1 agent chat: streams replies from /api/agent/chat and reloads
 * persisted history from /api/agent/history on mount.
 */
export const AgentChat = (props: { tenantSlug: string; tenantName: string }) => {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/agent/history?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        setMsgs((data.messages ?? []).map((m: Msg) => ({ role: m.role, content: m.content })));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [props.tenantSlug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setInput('');
    setBusy(true);
    setMsgs(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantSlug: props.tenantSlug, message: text }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const delta = decoder.decode(value, { stream: true });
        setMsgs((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + delta };
          }
          return next;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.';
      setMsgs((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          next[next.length - 1] = { role: 'assistant', content: `⚠️ ${msg}` };
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[65vh] flex-col rounded-lg border bg-background">
      <div className="border-b px-4 py-3 text-sm font-semibold">
        Agent —
        {' '}
        {props.tenantName}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {!loaded && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
        {loaded && msgs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask the agent anything about this workspace — strategy, copy, SEO,
            planning. Execution tools arrive with the MCP registry (Phase 2).
          </p>
        )}
        {msgs.map((m, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className={m.role === 'user'
              ? `
                ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm
                whitespace-pre-wrap text-primary-foreground
              `
              : `
                max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm
                whitespace-pre-wrap
              `}
          >
            {m.content || '…'}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="flex gap-2 border-t p-3">
        <input
          className="
            flex-1 rounded-md border border-input bg-background px-3 py-2
            text-sm outline-none
            focus:ring-2 focus:ring-ring
          "
          placeholder="Message the agent…"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          {busy ? '…' : 'Send'}
        </Button>
      </form>
    </div>
  );
};
