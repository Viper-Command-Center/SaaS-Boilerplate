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
      // tool/status lines get a subtle treatment
      if (/^\[(tool|approval|stopped|error)\]/.test(line.trim())) {
        return (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="
            flex w-fit items-center gap-1.5 rounded-full border
            border-indigo-400/20 bg-indigo-400/8 px-2 py-1 text-[11px]
            text-indigo-200/80
          "
          >
            <span className="pulse-dot size-1.5 rounded-full bg-indigo-400" />
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
