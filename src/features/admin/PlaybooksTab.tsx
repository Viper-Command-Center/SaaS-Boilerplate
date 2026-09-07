'use client';

/**
 * Admin → Playbooks (Phase 37).
 *
 * Platform-wide operating notes for the agents, editable without a deploy.
 * Scope "*" reaches every agent; a provider slug reaches every workspace
 * that has that provider enabled. Injected right after the code-shipped
 * tool guidance on the next turn. Each body change bumps the version and
 * keeps the previous body (who / when) so a bad edit can be pasted back.
 */

import type { BuiltinProvider } from '@/features/admin/CatalogTab';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export type Playbook = {
  id: string;
  scope: string;
  title: string;
  body: string;
  enabled: boolean;
  version: number;
  history: Array<{ version: number; body: string; changedBy: string | null; changedAt: string }>;
  updatedAt: string;
};

type Form = { scope: string; title: string; body: string; enabled: boolean };
const EMPTY: Form = { scope: '*', title: '', body: '', enabled: true };

export const PlaybooksTab = ({ builtins }: { builtins: BuiltinProvider[] }) => {
  const [items, setItems] = useState<Playbook[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch('/api/admin/playbooks')
      .then(r => (r.ok ? r.json() : { playbooks: [] }))
      .then(d => setItems(d.playbooks ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const reset = () => {
    setForm(EMPTY);
    setEditing(null);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(editing ? `/api/admin/playbooks/${editing}` : '/api/admin/playbooks', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(data?.error ?? 'Save failed.');
      return;
    }
    setNotice(editing ? `Saved — now v${data.playbook.version}. Agents see it on their next turn.` : 'Created. Agents see it on their next turn.');
    reset();
    reload();
  };

  const edit = (p: Playbook) => {
    setEditing(p.id);
    setForm({ scope: p.scope, title: p.title, body: p.body, enabled: p.enabled });
    setNotice(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggle = async (p: Playbook) => {
    await fetch(`/api/admin/playbooks/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !p.enabled }),
    }).catch(() => {});
    reload();
  };

  const remove = async (p: Playbook) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete playbook "${p.title}"? Agents stop seeing it on their next turn.`)) {
      return;
    }
    await fetch(`/api/admin/playbooks/${p.id}`, { method: 'DELETE' }).catch(() => {});
    if (editing === p.id) {
      reset();
    }
    reload();
  };

  const scopeLabel = (scope: string) => scope === '*' ? 'Every agent' : (builtins.find(b => b.slug === scope)?.name ?? scope);

  const input = 'w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-sm text-white/90 outline-none focus:border-indigo-400/50';
  const label = 'mb-1 block text-xs font-medium text-white/60';

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-xs text-muted-foreground">
        Standing rules every agent follows, without a deploy. A playbook scoped to a tool (e.g. WordPress Sites) reaches every workspace that has that tool enabled; scope
        {' '}
        <strong className="text-white/80">Every agent</strong>
        {' '}
        reaches all of them. Agents see changes on their next turn. Keep rules short and concrete — the tool guidance shipped with the code is still there underneath; this is the layer you own.
      </p>

      <form onSubmit={submit} className="glass space-y-4 p-5">
        <div className="
          grid gap-4
          md:grid-cols-[220px_1fr]
        "
        >
          <div>
            <label className={label} htmlFor="pb-scope">Applies to</label>
            <select id="pb-scope" className={input} value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}>
              <option value="*">Every agent</option>
              {builtins.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="pb-title">Title</label>
            <input id="pb-title" className={input} maxLength={160} placeholder="e.g. WordPress page builds — verify before and after" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required />
          </div>
        </div>
        <div>
          <label className={label} htmlFor="pb-body">Rules (markdown, up to 12,000 characters)</label>
          <textarea
            id="pb-body"
            className={`
              ${input}
              min-h-[220px] font-mono text-[13px] leading-relaxed
            `}
            maxLength={12_000}
            placeholder={'- Before writing a page layout, confirm the page id\'s TITLE with wp_content_get.\n- After building a page, fetch_url its live URL; header + footer only means blank.\n- Ability names are exact — read them from wp_mcp_tools.'}
            value={form.body}
            onChange={e => setForm({ ...form, body: e.target.value })}
            required
          />
          <p className="mt-1 text-[11px] text-white/35">
            {form.body.length.toLocaleString()}
            {' '}
            / 12,000
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
          Enabled
        </label>

        {error && <p className="text-sm text-rose-300" role="alert">{error}</p>}
        {notice && <p className="text-sm text-emerald-300">{notice}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create playbook'}
          </Button>
          {editing && <Button type="button" variant="outline" onClick={reset}>Cancel</Button>}
        </div>
      </form>

      <div className="glass p-5">
        <h2 className="mb-4 text-sm font-semibold text-white">
          Playbooks
          <span className="ml-2 text-xs font-normal text-white/40">{items.length}</span>
        </h2>
        {items.length === 0 && <p className="text-sm text-white/45">None yet. Create the first one above.</p>}
        <div className="space-y-3">
          {items.map(p => (
            <div
              key={p.id}
              className={`
                rounded-lg border border-white/8 p-4
                ${p.enabled
              ? ''
              : `opacity-60`}
              `}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="
                      rounded-sm bg-indigo-400/15 px-1.5 py-0.5 text-[10px]
                      font-medium text-indigo-300
                    "
                    >
                      {scopeLabel(p.scope)}
                    </span>
                    <span className="text-sm font-medium text-white">{p.title}</span>
                    <span className="text-[11px] text-white/40">
                      v
                      {p.version}
                      {' · '}
                      {new Date(p.updatedAt).toLocaleString()}
                    </span>
                    {!p.enabled && <span className="text-[11px] text-amber-300">disabled</span>}
                  </div>
                  <pre className="
                    mt-2 max-h-40 overflow-auto font-mono text-[12px]
                    leading-relaxed whitespace-pre-wrap text-white/70
                  "
                  >
                    {p.body}
                  </pre>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button type="button" size="sm" variant="outline" onClick={() => edit(p)}>Edit</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => toggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
                  {p.history.length > 0 && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setHistoryOf(historyOf === p.id ? null : p.id)}>
                      History (
                      {p.history.length}
                      )
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={() => remove(p)}>Delete</Button>
                </div>
              </div>
              {historyOf === p.id && (
                <div className="mt-3 space-y-2 border-t border-white/8 pt-3">
                  {p.history.map(h => (
                    <details key={h.version} className="text-xs text-white/60">
                      <summary className="cursor-pointer">
                        v
                        {h.version}
                        {' — '}
                        {h.changedBy ?? 'unknown'}
                        {', '}
                        {new Date(h.changedAt).toLocaleString()}
                      </summary>
                      <pre className="
                        mt-1 font-mono text-[12px] whitespace-pre-wrap
                        text-white/55
                      "
                      >
                        {h.body}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
