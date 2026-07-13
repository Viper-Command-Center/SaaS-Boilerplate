'use client';

import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/BrandLogo';

type Msg = { role: 'user' | 'assistant'; content: string };

/** Very small markdown renderer: **bold**, `code`, and line breaks. */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null = regex.exec(text);
  let key = 0;

  while (m) {
    if (m.index > last) {
      parts.push(text.slice(last, m.index));
    }
    const token = m[0];
    if (token.startsWith('**')) {
      // eslint-disable-next-line react/no-array-index-key
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code key={key++} className="rounded bg-foreground/10 px-1 py-0.5 text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
    m = regex.exec(text);
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

const MessageBody = ({ text }: { text: string }) => (
  <div className="space-y-1.5">
    {text.split('\n').map((line, i) => {
      if (!line.trim()) {
        // eslint-disable-next-line react/no-array-index-key
        return <div key={i} className="h-1" />;
      }
      // tool/status lines get a subtle treatment
      if (/^\[(tool|approval|stopped|error)\]/.test(line.trim())) {
        return (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="
            flex items-center gap-1.5 text-xs text-muted-foreground italic
          "
          >
            <span className="
              size-1.5 animate-pulse rounded-full bg-indigo-400
            "
            />
            {line.replace(/^\[[a-z]+\]\s*/, '')}
          </div>
        );
      }
      return (
        // eslint-disable-next-line react/no-array-index-key
        <p key={i} className="leading-relaxed">{renderInline(line)}</p>
      );
    })}
  </div>
);

/**
 * Compact, modern agent chat. Auto-growing composer, tight bubbles, tool
 * activity rendered as subtle status lines rather than raw text.
 */
export const AgentChat = (props: { tenantSlug: string; tenantName: string }) => {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLoaded(false);
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

  const grow = () => {
    const ta = taRef.current;
    if (!ta) {
      return;
    }
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setInput('');
    if (taRef.current) {
      taRef.current.style.height = 'auto';
    }
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
          next[next.length - 1] = { role: 'assistant', content: `[error] ${msg}` };
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const suggestions = [
    'What can you do for this workspace?',
    'Draft this week\'s content plan',
    'Show me our key metrics as panels',
  ];

  return (
    <div className="
      flex h-[62vh] min-h-[420px] flex-col overflow-hidden rounded-2xl border
      bg-background shadow-sm
    "
    >
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <BrandMark size={18} />
        <span className="text-sm font-semibold">Agent</span>
        <span className="text-xs text-muted-foreground">
          ·
          {' '}
          {props.tenantName}
        </span>
        {busy && (
          <span className="
            ml-auto flex items-center gap-1.5 text-xs text-muted-foreground
          "
          >
            <span className="size-1.5 animate-pulse rounded-full bg-indigo-500" />
            working…
          </span>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!loaded && <p className="text-sm text-muted-foreground">Loading…</p>}

        {loaded && msgs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <BrandMark size={40} />
            <div>
              <p className="text-sm font-medium">Brief your agent</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                It knows this workspace, its tools and its guardrails. Give it a
                goal the way you would a colleague.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInput(s)}
                  className="
                    rounded-full border px-3 py-1.5 text-xs text-muted-foreground
                    transition
                    hover:bg-muted hover:text-foreground
                  "
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className={m.role === 'user' ? 'flex justify-end' : 'flex gap-2.5'}
          >
            {m.role === 'assistant' && (
              <span className="mt-0.5 shrink-0">
                <BrandMark size={22} />
              </span>
            )}
            <div
              className={m.role === 'user'
                ? `
                  max-w-[75%] rounded-2xl rounded-br-md bg-foreground px-3.5 py-2
                  text-sm text-background
                `
                : 'max-w-[85%] text-sm'}
            >
              {m.content
                ? <MessageBody text={m.content} />
                : (
                    <span className="flex gap-1 py-1">
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:120ms]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:240ms]" />
                    </span>
                  )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="border-t p-3">
        <div className="
          flex items-end gap-2 rounded-xl border bg-background px-3 py-2
          transition focus-within:ring-2 focus-within:ring-ring
        "
        >
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              grow();
            }}
            onKeyDown={onKeyDown}
            placeholder="Message the agent…  (Enter to send, Shift+Enter for a new line)"
            className="
              max-h-40 flex-1 resize-none bg-transparent py-1 text-sm
              outline-none
            "
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="
              flex size-8 shrink-0 items-center justify-center rounded-lg
              bg-foreground text-background transition
              disabled:opacity-30
            "
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
};
