'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export type Issue = {
  id: string;
  kind: 'config' | 'provider' | 'platform' | string;
  source: string;
  message: string;
  status: string;
  reportedByAgent: boolean;
  createdAt: string;
  workspace: string | null;
  bundle: string;
};

const KIND_STYLE: Record<string, string> = {
  platform: 'bg-rose-400/15 text-rose-300', // our bug — we must fix it
  config: 'bg-amber-400/15 text-amber-300', // the client can fix it
  provider: 'bg-sky-400/15 text-sky-300', // third party's problem
};

const KIND_LABEL: Record<string, string> = {
  platform: 'our bug',
  config: 'client config',
  provider: 'provider',
};

export const IssuesTab = () => {
  const [items, setItems] = useState<Issue[]>([]);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch(`/api/admin/issues?status=${status}`)
      .then(r => (r.ok ? r.json() : { issues: [] }))
      .then(d => setItems(d.issues ?? []))
      .catch(() => {});
  }, [status]);

  useEffect(() => {
    reload();
    const i = setInterval(reload, 30_000);
    return () => clearInterval(i);
  }, [reload]);

  const resolve = async (id: string) => {
    await fetch('/api/admin/issues', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'resolved' }),
    }).catch(() => {});
    reload();
  };

  const copy = async (issue: Issue) => {
    await navigator.clipboard.writeText(issue.bundle).catch(() => {});
    setCopied(issue.id);
    setTimeout(() => setCopied(null), 2000);
  };

  const ourBugs = items.filter(i => i.kind === 'platform' && i.status === 'open').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Failures are triaged automatically.
          {' '}
          <strong className="text-rose-300">Our bugs</strong>
          {' '}
          are emailed to you the moment they happen, with a diagnostic bundle — the client never has to describe the symptom.
          {' '}
          <strong className="text-amber-300">Client config</strong>
          {' '}
          and
          {' '}
          <strong className="text-sky-300">provider</strong>
          {' '}
          problems are logged but not escalated.
        </p>
        <div className="flex gap-1.5">
          {(['open', 'all'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                status === s ? 'grad-fill text-white' : 'border border-white/12 text-white/50 hover:bg-white/5'
              }`}
            >
              {s === 'open' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {ourBugs > 0 && (
        <p className="glass p-3 text-sm text-rose-300">
          {ourBugs}
          {' '}
          open platform
          {ourBugs === 1 ? ' bug' : ' bugs'}
          {' '}
          need a code fix. Copy the bundle and hand it to an engineer.
        </p>
      )}

      <div className="glass glass-topline relative divide-y divide-white/6">
        {items.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-white/45">
            Nothing here. Failures will appear automatically as they happen.
          </p>
        )}

        {items.map(i => (
          <div key={i.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${KIND_STYLE[i.kind] ?? 'bg-white/10 text-white/50'}`}>
                    {KIND_LABEL[i.kind] ?? i.kind}
                  </span>
                  <span className="truncate text-sm font-medium text-white">{i.source}</span>
                  {i.reportedByAgent && (
                    <span className="rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px] text-indigo-300">
                      agent-reported
                    </span>
                  )}
                  {i.workspace && <span className="text-xs text-white/35">{i.workspace}</span>}
                </div>
                <p className="mt-1 line-clamp-2 font-mono text-xs text-white/50">{i.message}</p>
                <p className="mt-0.5 text-[11px] text-white/30">
                  {new Date(i.createdAt).toLocaleString()}
                </p>
              </div>

              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={() => setOpen(open === i.id ? null : i.id)}>
                  {open === i.id ? 'Hide' : 'Details'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => copy(i)}>
                  {copied === i.id ? 'Copied' : 'Copy bundle'}
                </Button>
                {i.status === 'open' && (
                  <Button size="sm" variant="outline" onClick={() => resolve(i.id)}>Resolve</Button>
                )}
              </div>
            </div>

            {open === i.id && (
              <pre className="
                mt-3 max-h-80 overflow-auto rounded-lg bg-black/30 p-3 text-[11px]
                whitespace-pre-wrap text-white/60
              "
              >
                {i.bundle}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
