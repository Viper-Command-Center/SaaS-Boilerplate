'use client';

/**
 * Admin → Models (Phase 43).
 *
 * The Bedrock Mantle model catalog: add a newly-available model or reprice
 * an existing one without a deploy. This is what populates the Chat/Build
 * model dropdowns on the Workspaces tab.
 *
 * toolUseVerified starts false for every model (see migrations/0024) because
 * Mantle's own console doesn't expose a tool-calling capability flag — only
 * a live mission test can confirm it. Flip the checkbox here only after
 * that test actually passes; leaving it off just means "not tested yet",
 * not "broken".
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export type ModelCatalogRow = {
  id: string;
  provider: string;
  displayName: string;
  apiFormat: 'anthropic' | 'openai';
  inputPricePerM: string | number;
  outputPricePerM: string | number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsReasoning: boolean;
  toolUseVerified: boolean;
  notes: string | null;
  active: boolean;
};

type Form = {
  id: string;
  provider: string;
  displayName: string;
  apiFormat: 'anthropic' | 'openai';
  inputPricePerM: string;
  outputPricePerM: string;
  supportsReasoning: boolean;
  notes: string;
  active: boolean;
};

const EMPTY: Form = {
  id: '',
  provider: '',
  displayName: '',
  apiFormat: 'openai',
  inputPricePerM: '',
  outputPricePerM: '',
  supportsReasoning: false,
  notes: '',
  active: true,
};

export const ModelsTab = () => {
  const [items, setItems] = useState<ModelCatalogRow[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch('/api/admin/models')
      .then(r => (r.ok ? r.json() : { models: [] }))
      .then(d => setItems(d.models ?? []))
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
    const res = await fetch('/api/admin/models', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: form.id.trim(),
        provider: form.provider.trim(),
        displayName: form.displayName.trim(),
        apiFormat: form.apiFormat,
        inputPricePerM: Number(form.inputPricePerM),
        outputPricePerM: Number(form.outputPricePerM),
        supportsReasoning: form.supportsReasoning,
        notes: form.notes.trim() || undefined,
        active: form.active,
      }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(data?.error ?? 'Save failed.');
      return;
    }
    setNotice(editing ? 'Saved.' : 'Added to the catalog — it now shows up in the Chat/Build model pickers.');
    reset();
    reload();
  };

  const edit = (m: ModelCatalogRow) => {
    setEditing(m.id);
    setForm({
      id: m.id,
      provider: m.provider,
      displayName: m.displayName,
      apiFormat: m.apiFormat,
      inputPricePerM: String(m.inputPricePerM),
      outputPricePerM: String(m.outputPricePerM),
      supportsReasoning: m.supportsReasoning,
      notes: m.notes ?? '',
      active: m.active,
    });
    setNotice(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleActive = async (m: ModelCatalogRow) => {
    await fetch('/api/admin/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: m.id, active: !m.active }),
    }).catch(() => {});
    reload();
  };

  const toggleVerified = async (m: ModelCatalogRow) => {
    await fetch('/api/admin/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: m.id, toolUseVerified: !m.toolUseVerified }),
    }).catch(() => {});
    reload();
  };

  const remove = async (m: ModelCatalogRow) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove "${m.displayName}" from the catalog? Any workspace currently assigned to it keeps using it by id until reassigned.`)) {
      return;
    }
    await fetch(`/api/admin/models?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' }).catch(() => {});
    if (editing === m.id) {
      reset();
    }
    reload();
  };

  const input = 'w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-sm text-white/90 outline-none focus:border-indigo-400/50';
  const label = 'mb-1 block text-xs font-medium text-white/60';

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-xs text-muted-foreground">
        The Bedrock Mantle models available to assign per workspace, chat vs. build, on the Workspaces tab. Model id must be the
        {' '}
        <strong className="text-white/80">exact</strong>
        {' '}
        Mantle model id (e.g.
        {' '}
        <code className="text-white/70">anthropic.claude-sonnet-5</code>
        {' '}
        or
        {' '}
        <code className="text-white/70">deepseek.v3.2</code>
        ) — it's sent verbatim in every API call. Prices are USD per 1M tokens.
      </p>

      <form onSubmit={submit} className="glass space-y-4 p-5">
        <div className="
          grid gap-4
          md:grid-cols-3
        "
        >
          <div>
            <label className={label} htmlFor="mc-id">Model id</label>
            <input id="mc-id" className={input} placeholder="e.g. moonshotai.kimi-k2.5" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} disabled={Boolean(editing)} required />
          </div>
          <div>
            <label className={label} htmlFor="mc-provider">Provider</label>
            <input id="mc-provider" className={input} placeholder="e.g. moonshotai" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} required />
          </div>
          <div>
            <label className={label} htmlFor="mc-name">Display name</label>
            <input id="mc-name" className={input} placeholder="e.g. Kimi K2.5" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} required />
          </div>
        </div>
        <div className="
          grid gap-4
          md:grid-cols-4
        "
        >
          <div>
            <label className={label} htmlFor="mc-format">API shape</label>
            <select id="mc-format" className={input} value={form.apiFormat} onChange={e => setForm({ ...form, apiFormat: e.target.value as 'anthropic' | 'openai' })}>
              <option value="anthropic">Anthropic (Claude models)</option>
              <option value="openai">OpenAI (everything else)</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="mc-in">Input $ / 1M tok</label>
            <input id="mc-in" type="number" step="0.0001" min="0" className={input} value={form.inputPricePerM} onChange={e => setForm({ ...form, inputPricePerM: e.target.value })} required />
          </div>
          <div>
            <label className={label} htmlFor="mc-out">Output $ / 1M tok</label>
            <input id="mc-out" type="number" step="0.0001" min="0" className={input} value={form.outputPricePerM} onChange={e => setForm({ ...form, outputPricePerM: e.target.value })} required />
          </div>
          <div className="flex items-end gap-4 pb-2">
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.supportsReasoning} onChange={e => setForm({ ...form, supportsReasoning: e.target.checked })} />
              Reasoning-capable
            </label>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />
              Active
            </label>
          </div>
        </div>
        <div>
          <label className={label} htmlFor="mc-notes">Notes</label>
          <input id="mc-notes" className={input} maxLength={2000} placeholder="e.g. tool-use not yet verified — test before build work" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>

        {error && <p className="text-sm text-rose-300" role="alert">{error}</p>}
        {notice && <p className="text-sm text-emerald-300">{notice}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add model'}
          </Button>
          {editing && <Button type="button" variant="outline" onClick={reset}>Cancel</Button>}
        </div>
      </form>

      <div className="glass overflow-x-auto p-5">
        <h2 className="mb-4 text-sm font-semibold text-white">
          Catalog
          <span className="ml-2 text-xs font-normal text-white/40">{items.length}</span>
        </h2>
        <table className="w-full text-sm">
          <thead className="
            border-b border-white/8 text-left text-[10px] tracking-wider
            text-white/40 uppercase
          "
          >
            <tr>
              <th className="p-2">Model</th>
              <th className="p-2">Shape</th>
              <th className="p-2">Price (in / out per 1M)</th>
              <th className="p-2">Tool-use verified</th>
              <th className="p-2">Status</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {items.map(m => (
              <tr
                key={m.id}
                className={`
                  border-t border-white/6
                  ${m.active
                ? ''
                : `opacity-50`}
                `}
              >
                <td className="p-2">
                  <div className="font-medium text-white/90">{m.displayName}</div>
                  <div className="text-[11px] text-white/40">{m.id}</div>
                </td>
                <td className="p-2 text-white/70">{m.apiFormat}</td>
                <td className="p-2 text-white/70">
                  $
                  {Number(m.inputPricePerM).toFixed(2)}
                  {' / $'}
                  {Number(m.outputPricePerM).toFixed(2)}
                </td>
                <td className="p-2">
                  <button
                    type="button"
                    onClick={() => toggleVerified(m)}
                    className={`
                      rounded-full px-2 py-0.5 text-[11px] font-medium
                      ${
              m.toolUseVerified
                ? 'bg-emerald-400/15 text-emerald-300'
                : `bg-amber-400/15 text-amber-300`
              }
                    `}
                  >
                    {m.toolUseVerified ? 'Verified' : 'Untested'}
                  </button>
                </td>
                <td className="p-2 text-white/70">{m.active ? 'Active' : 'Disabled'}</td>
                <td className="p-2">
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" size="sm" variant="outline" onClick={() => edit(m)}>Edit</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => toggleActive(m)}>{m.active ? 'Disable' : 'Enable'}</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => remove(m)}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={6} className="p-4 text-muted-foreground">No models yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
