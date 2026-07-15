'use client';

import { useEffect, useRef, useState } from 'react';
import { AgentAvatar } from '@/features/agent/AgentAvatar';

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
      parts.push(<strong key={key++} className="text-white">{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code key={key++} className="rounded bg-white/10 px-1 py-0.5 text-[0.85em] text-indigo-200">
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
      // Tool / approval / error activity rendered as a status chip.
      if (/^\[(?:tool|approval|stopped|error)\]/.test(line.trim())) {
        const isError = /^\[(?:error|stopped)\]/.test(line.trim());
        return (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className={`flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
              isError
                ? 'border-rose-400/25 bg-rose-400/10 text-rose-200'
                : 'border-indigo-400/25 bg-indigo-400/10 text-indigo-200'
            }`}
          >
            <span className={`pulse-dot size-1.5 rounded-full ${isError ? 'bg-rose-400' : 'bg-indigo-400'}`} />
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
 * The agent console. Glass surface, gradient composer, tool activity shown as
 * live status chips rather than raw text.
 */
export const AgentChat = (props: {
  tenantSlug: string;
  tenantName: string;
  agentName?: string;
  agentAvatarUrl?: string | null;
  agentAccent?: string;
}) => {
  const agentName = props.agentName || 'Agent';
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
      glass glass-topline relative flex h-[62vh] min-h-[440px] flex-col
      overflow-hidden
    "
    >
      {/* Header */}
      <div className="
        flex items-center gap-2 border-b border-white/8 px-4 py-3
      "
      >
        <AgentAvatar name={agentName} avatarUrl={props.agentAvatarUrl} accent={props.agentAccent} size={18} />
        <span className="text-sm font-semibold text-white">{agentName}</span>
        <span className="text-xs text-white/35">
          ·
          {' '}
          {props.tenantName}
        </span>
        {busy
          ? (
              <span className="
                ml-auto flex items-center gap-1.5 rounded-full border
                border-indigo-400/30 bg-indigo-400/10 px-2.5 py-0.5 text-[11px]
                text-indigo-200
              "
              >
                <span className="pulse-dot size-1.5 rounded-full bg-indigo-400" />
                thinking
              </span>
            )
          : (
              <span className="
                ml-auto flex items-center gap-1.5 rounded-full border
                border-emerald-400/25 bg-emerald-400/10 px-2.5 py-0.5
                text-[11px] text-emerald-300
              "
              >
                <span className="size-1.5 rounded-full bg-emerald-400" />
                online
              </span>
            )}
      </div>

      {/* Transcript */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!loaded && <p className="text-sm text-white/40">Loading…</p>}

        {loaded && msgs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="glow-ring rounded-2xl">
              <AgentAvatar name={agentName} avatarUrl={props.agentAvatarUrl} accent={props.agentAccent} size={44} />
            </span>
            <div>
              <p className="text-sm font-semibold text-white">
                Brief
                {' '}
                {agentName === 'Agent' ? 'your agent' : agentName}
              </p>
              <p className="mt-1 max-w-sm text-sm text-white/45">
                {agentName === 'Agent' ? 'It' : `${agentName}`}
                {' '}
                knows this workspace, its tools and its guardrails. Give
                {agentName === 'Agent' ? ' it' : ' them'}
                {' '}
                a goal the way you would a colleague.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInput(s)}
                  className="
                    rounded-full border border-white/12 px-3 py-1.5 text-xs
                    text-white/55 transition
                    hover:border-indigo-400/40 hover:bg-white/5 hover:text-white
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
                <AgentAvatar name={agentName} avatarUrl={props.agentAvatarUrl} accent={props.agentAccent} size={22} />
              </span>
            )}
            <div
              className={m.role === 'user'
                ? `
                  grad-fill max-w-[75%] rounded-2xl rounded-br-md px-3.5 py-2
                  text-sm text-white shadow-lg shadow-indigo-900/40
                `
                : 'max-w-[85%] text-sm text-white/80'}
            >
              {m.content
                ? <MessageBody text={m.content} />
                : (
                    <span className="flex gap-1 py-1.5">
                      <span className="size-1.5 animate-bounce rounded-full bg-indigo-400/80" />
                      <span className="size-1.5 animate-bounce rounded-full bg-fuchsia-400/80 [animation-delay:120ms]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-indigo-300/80 [animation-delay:240ms]" />
                    </span>
                  )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <form onSubmit={send} className="border-t border-white/8 p-3">
        <div className="
          flex items-end gap-2 rounded-xl border border-white/10
          bg-white/[0.04] px-3 py-2 transition
          focus-within:border-indigo-400/40 focus-within:bg-white/[0.06]
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
            placeholder={`Message ${agentName === 'Agent' ? 'the agent' : agentName}…  (Enter to send, Shift+Enter for a new line)`}
            className="
              max-h-40 flex-1 resize-none bg-transparent py-1 text-sm
              text-white/90 outline-none
              placeholder:text-white/30
            "
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="
              grad-fill flex size-8 shrink-0 items-center justify-center
              rounded-lg text-white shadow-lg shadow-indigo-900/40 transition
              hover:brightness-110
              disabled:opacity-25 disabled:shadow-none
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
