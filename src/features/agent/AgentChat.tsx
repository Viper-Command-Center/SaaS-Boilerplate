'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentAvatar } from '@/features/agent/AgentAvatar';

type Msg = { role: 'user' | 'assistant'; content: string };

/** An image pasted into the composer, mid- or post-upload. */
type Attachment = {
  localId: string;
  /** Set once the upload is confirmed — this is what the API receives. */
  id?: string;
  name: string;
  /** Object URL for the thumbnail. Revoked on remove/send to avoid a leak. */
  previewUrl: string;
  uploading: boolean;
};

/**
 * How close to the bottom you must be for the transcript to keep following a
 * streaming reply. Above this, you've scrolled up deliberately and we leave you
 * alone. ~120px ≈ a line or two of slack, so a small nudge doesn't unstick it.
 */
const STICK_THRESHOLD_PX = 120;

/** Mirrors libs/agent/vision.ts — Anthropic's supported image types. */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Mirrors MAX_IMAGES_PER_MESSAGE in vision.ts. Checked server-side too. */
const MAX_IMAGES = 4;

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
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** The transcript element. We scroll THIS, never the document. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Paste or drop an image → straight to R2 → keep the file id.
   *
   * Bytes never touch the app server: we mint a presigned PUT and the browser
   * uploads directly to Cloudflare (the same path the file library uses). The
   * chat request then carries a file id, not a base64 blob.
   */
  const upload = useCallback(async (file: File) => {
    setUploadError(null);
    if (!ACCEPTED.has(file.type)) {
      setUploadError(`${file.type || 'That file type'} can't be viewed — use PNG, JPEG, GIF or WebP.`);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError(`That image is ${Math.round(file.size / 1024 / 1024)}MB — the limit is 5MB.`);
      return;
    }

    const localId = Math.random().toString(36).slice(2);
    const previewUrl = URL.createObjectURL(file);
    setPending(prev => [...prev, { localId, name: file.name, previewUrl, uploading: true }]);

    try {
      const startRes = await fetch(`/api/files/upload?tenant=${encodeURIComponent(props.tenantSlug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name || 'screenshot.png', sizeBytes: file.size }),
      });
      const start = await startRes.json();
      if (!startRes.ok) {
        throw new Error(start?.error ?? 'Could not start the upload.');
      }

      const put = await fetch(start.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!put.ok) {
        throw new Error(`Storage rejected the upload (${put.status}).`);
      }

      const confirmRes = await fetch(`/api/files/upload?tenant=${encodeURIComponent(props.tenantSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: start.key, name: file.name || 'screenshot.png', mime: file.type }),
      });
      const confirmed = await confirmRes.json();
      if (!confirmRes.ok || !confirmed?.file?.id) {
        throw new Error(confirmed?.error ?? 'Could not save the image.');
      }

      setPending(prev =>
        prev.map(p => (p.localId === localId ? { ...p, id: confirmed.file.id, uploading: false } : p)),
      );
    } catch (err) {
      // Drop the chip and say why. A silent failure here would leave the user
      // thinking the agent can see something it can't.
      setPending(prev => prev.filter(p => p.localId !== localId));
      URL.revokeObjectURL(previewUrl);
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    }
  }, [props.tenantSlug]);

  const addFiles = useCallback((files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) {
      return;
    }
    const room = MAX_IMAGES - pending.length;
    if (room <= 0) {
      setUploadError(`You can attach up to ${MAX_IMAGES} images per message.`);
      return;
    }
    images.slice(0, room).forEach(upload);
  }, [pending.length, upload]);

  const removePending = (localId: string) => {
    setPending((prev) => {
      const hit = prev.find(p => p.localId === localId);
      if (hit) {
        URL.revokeObjectURL(hit.previewUrl);
      }
      return prev.filter(p => p.localId !== localId);
    });
  };

  const loadHistory = useCallback((showSpinner: boolean) => {
    if (showSpinner) {
      setLoaded(false);
    }
    fetch(`/api/agent/history?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        setMsgs((data.messages ?? []).map((m: Msg) => ({ role: m.role, content: m.content })));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [props.tenantSlug]);

  useEffect(() => {
    loadHistory(true);
  }, [loadHistory]);

  // Approving a queued call runs the tool and lets the agent continue — the
  // reply is written server-side, so pull it in when the Approvals panel says
  // a decision landed. Without this the agent's continuation stays invisible
  // and it looks like approving does nothing (which is how it behaved).
  useEffect(() => {
    const onUpdate = () => loadHistory(false);
    window.addEventListener('artivio:conversation-updated', onUpdate);
    return () => window.removeEventListener('artivio:conversation-updated', onUpdate);
  }, [loadHistory]);

  /**
   * Keep the transcript pinned to the bottom — WITHOUT moving the page.
   *
   * This used to be `bottomRef.current.scrollIntoView()`, which has a nasty
   * property: it scrolls EVERY scrollable ancestor, including the document. So
   * each streamed token dragged the whole dashboard down and the user had to
   * scroll back up, once per word. Setting scrollTop on the transcript element
   * itself can only ever move that element.
   *
   * It also only follows when you're ALREADY near the bottom. If you've scrolled
   * up to re-read something, a long reply must not yank you away from it —
   * that's your scroll position, not ours to take.
   */
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= STICK_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    stickToBottom();
  }, [msgs, stickToBottom]);

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
    // Don't send while an image is still uploading — the agent would answer
    // about a screenshot it never received.
    if (pending.some(p => p.uploading)) {
      setUploadError('Still uploading — one moment.');
      return;
    }

    const attachments = pending.map(p => p.id).filter((id): id is string => Boolean(id));

    setInput('');
    if (taRef.current) {
      taRef.current.style.height = 'auto';
    }
    pending.forEach(p => URL.revokeObjectURL(p.previewUrl));
    setPending([]);
    setUploadError(null);
    setBusy(true);
    setMsgs(prev => [
      ...prev,
      {
        role: 'user',
        content: attachments.length > 0
          ? `${text}\n\n_[${attachments.length} image${attachments.length > 1 ? 's' : ''} attached]_`
          : text,
      },
      { role: 'assistant', content: '' },
    ]);

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: props.tenantSlug,
          message: text,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
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

  /** Cmd/Ctrl+Shift+4 then Cmd/Ctrl+V — the whole point of the feature. */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.some(f => f.type.startsWith('image/'))) {
      e.preventDefault(); // else the filename lands in the textarea as text
      addFiles(files);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
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
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
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
      </div>

      {/* Composer */}
      <form
        onSubmit={send}
        className="border-t border-white/8 p-3"
        onDrop={onDrop}
        onDragOver={e => e.preventDefault()}
      >
        {/* Attached images — thumbnails, because a filename tells you nothing
            about whether you grabbed the right screenshot. */}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map(p => (
              <div
                key={p.localId}
                className="group relative size-16 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.previewUrl} alt={p.name} className="size-full object-cover" />
                {p.uploading && (
                  <div className="absolute inset-0 grid place-items-center bg-black/60">
                    <div className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePending(p.localId)}
                  aria-label={`Remove ${p.name}`}
                  className="
                    absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full
                    bg-black/70 text-xs text-white/80 opacity-0 transition
                    hover:bg-black/90 hover:text-white group-hover:opacity-100
                  "
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {uploadError && (
          <p className="mb-2 text-xs text-rose-300/90">{uploadError}</p>
        )}

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
            onPaste={onPaste}
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
