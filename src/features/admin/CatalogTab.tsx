'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export type PriceRule = { unit: 'call' | 'arg'; argField?: string; costUsd: number; markup?: number };

export type Plugin = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  tier: string;
  transport: string;
  provider: string | null;
  url: string | null;
  authHeader: string | null;
  authHint: string | null;
  enabled: boolean;
  hasCredential: boolean;
  priceRules: Record<string, PriceRule> | null;
};

export type BuiltinProvider = {
  slug: string;
  name: string;
  description: string;
  credentialLabel: string;
  perConnection?: boolean;
  tools: Array<{ name: string; description: string; meteredArg?: string }>;
};

export type CatalogPreset = {
  key: string;
  label: string;
  entry: {
    slug: string;
    name: string;
    description: string;
    category: string;
    transport: 'http' | 'builtin';
    provider?: string;
    url?: string;
    authHeader?: string;
    authHint?: string;
  };
};

const CATEGORIES = ['media', 'seo', 'social', 'ads', 'analytics', 'dev', 'data', 'other'];

type Row = { tool: string; unit: 'call' | 'arg'; argField: string; costUsd: string; markupPct: string };

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

const EMPTY = {
  slug: '',
  name: '',
  description: '',
  category: 'media',
  tier: 'tier1',
  provider: '',
  url: '',
  authHeader: 'Authorization',
  authHint: '',
  credentialValue: '',
};

export const CatalogTab = (props: {
  catalog: Plugin[];
  builtins: BuiltinProvider[];
  presets?: CatalogPreset[];
  reload: () => void;
}) => {
  const [show, setShow] = useState(false);
  /** null = creating a new entry; otherwise the id being edited. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'builtin' | 'http'>('builtin');
  const [form, setForm] = useState({ ...EMPTY });
  const [rows, setRows] = useState<Row[]>([]);
  const [defaultMarkup, setDefaultMarkup] = useState('30');

  const input = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  const rowsFromRules = (rules: Record<string, PriceRule> | null | undefined, tools?: BuiltinProvider['tools']) => {
    const names = tools?.length
      ? tools.map(t => t.name)
      : Object.keys(rules ?? {});
    return names.map((name) => {
      const r = rules?.[name];
      const meteredArg = tools?.find(t => t.name === name)?.meteredArg;
      return {
        tool: name,
        unit: (r?.unit ?? (meteredArg ? 'arg' : 'call')) as 'call' | 'arg',
        argField: r?.argField ?? meteredArg ?? '',
        costUsd: r ? String(r.costUsd) : '',
        markupPct: r?.markup !== undefined ? String(Math.round((r.markup - 1) * 100)) : defaultMarkup,
      };
    });
  };

  const reset = () => {
    setShow(false);
    setEditingId(null);
    setError(null);
    setRows([]);
    setForm({ ...EMPTY });
  };

  /** Picking a built-in provider pre-fills the identity and the pricing rows. */
  const pickProvider = (slug: string) => {
    const p = props.builtins.find(b => b.slug === slug);
    if (!p) {
      setForm(f => ({ ...f, provider: '' }));
      setRows([]);
      return;
    }
    setForm(f => ({
      ...f,
      provider: p.slug,
      // Don't clobber the slug/name when correcting an existing entry.
      slug: editingId ? f.slug : p.slug,
      name: editingId ? f.name : p.name,
      description: editingId && f.description ? f.description : p.description.slice(0, 300),
    }));
    setRows(rowsFromRules(null, p.tools));
  };

  const applyPreset = (preset: CatalogPreset) => {
    const e = preset.entry;
    setEditingId(null);
    setShow(true);
    setError(null);
    setKind(e.transport);
    setForm({
      ...EMPTY,
      slug: e.slug,
      name: e.name,
      description: e.description,
      category: e.category,
      // Presets are client-owned accounts by default → tier 2 (BYO credential).
      tier: 'tier2',
      provider: e.provider ?? '',
      url: e.url ?? '',
      authHeader: e.authHeader ?? 'Authorization',
      authHint: e.authHint ?? '',
    });
    const bp = e.provider ? props.builtins.find(b => b.slug === e.provider) : undefined;
    setRows(bp ? rowsFromRules(null, bp.tools) : []);
  };

  const startEdit = (p: Plugin) => {
    setEditingId(p.id);
    setShow(true);
    setError(null);
    setKind(p.transport === 'builtin' ? 'builtin' : 'http');
    setForm({
      slug: p.slug,
      name: p.name,
      description: p.description ?? '',
      category: p.category ?? 'other',
      tier: p.tier,
      provider: p.provider ?? '',
      url: p.url ?? '',
      authHeader: p.authHeader ?? 'Authorization',
      authHint: p.authHint ?? '',
      credentialValue: '',
    });
    const bp = p.provider ? props.builtins.find(b => b.slug === p.provider) : undefined;
    setRows(rowsFromRules(p.priceRules, bp?.tools));
  };

  const setRow = (i: number, patch: Partial<Row>) => {
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const applyMarkupToAll = (pct: string) => {
    setDefaultMarkup(pct);
    setRows(rs => rs.map(r => ({ ...r, markupPct: pct })));
  };

  const buildPriceRules = (): Record<string, PriceRule> => {
    const out: Record<string, PriceRule> = {};
    for (const r of rows) {
      const cost = Number(r.costUsd);
      if (!r.tool || !Number.isFinite(cost) || cost < 0 || r.costUsd === '') {
        continue;
      }
      out[r.tool] = {
        unit: r.unit,
        ...(r.unit === 'arg' && r.argField ? { argField: r.argField } : {}),
        costUsd: cost,
        markup: 1 + (Number(r.markupPct) || 0) / 100,
      };
    }
    return out;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const shared = {
      name: form.name,
      description: form.description || undefined,
      category: form.category,
      tier: form.tier,
      transport: kind,
      provider: kind === 'builtin' ? form.provider : undefined,
      url: kind === 'http' ? form.url : undefined,
      authHeader: kind === 'http' ? form.authHeader : undefined,
      authHint: form.authHint || undefined,
      priceRules: form.tier === 'tier1' ? buildPriceRules() : {},
      // Blank on an edit = keep the stored key.
      credentialValue: form.credentialValue || undefined,
    };

    const res = await fetch('/api/admin/catalog', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingId ? { id: editingId, ...shared } : { slug: form.slug, ...shared }),
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(data?.error ?? 'Could not save.');
      return;
    }
    reset();
    props.reload();
  };

  const toggle = async (p: Plugin) => {
    await fetch('/api/admin/catalog', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, enabled: !p.enabled }),
    }).catch(() => {});
    props.reload();
  };

  const del = async (id: string) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Remove this plugin from the catalog?')) {
      return;
    }
    await fetch(`/api/admin/catalog?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    props.reload();
  };

  const editing = editingId ? props.catalog.find(p => p.id === editingId) : undefined;
  const activeBuiltin = props.builtins.find(b => b.slug === form.provider);
  const presets = props.presets ?? [];
  const saveLabel = editing ? 'Save changes' : 'Save plugin';
  // Per-site providers (WordPress) have no platform key — the workspace enters
  // their own site + credential when they enable it.
  const perConnection = kind === 'builtin' && Boolean(activeBuiltin?.perConnection);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          <strong>Tier 1</strong>
          {' '}
          = your account. Usage is metered and billed to the client at your markup.
          {' '}
          <strong>Tier 2</strong>
          {' '}
          = the client brings their own key; you don&apos;t pay or meter it.
        </p>
        <Button size="sm" variant="outline" onClick={() => (show ? reset() : setShow(true))}>
          {show ? 'Cancel' : 'Add plugin'}
        </Button>
      </div>

      {/* One-click starting points — just form pre-fills. */}
      {!show && presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Quick add:</span>
          {presets.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p)}
              className="
                rounded-lg border border-white/12 px-2.5 py-1 text-xs
                text-white/70
                hover:bg-white/5
              "
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {show && (
        <form onSubmit={submit} className="glass space-y-4 p-4">
          <p className="text-sm font-medium">
            {editing ? `Edit ${editing.name}` : 'New plugin'}
          </p>

          {/* what kind */}
          <div className="flex gap-2">
            {(['builtin', 'http'] as const).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  kind === k ? 'grad-fill border-transparent text-white' : 'border-white/12 text-white/50'
                }`}
              >
                {k === 'builtin' ? 'Built-in provider (REST API we wrap)' : 'Hosted MCP server (URL)'}
              </button>
            ))}
          </div>

          {kind === 'builtin'
            ? (
                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="cat-provider">Provider</label>
                  <select id="cat-provider" className={input} value={form.provider} onChange={e => pickProvider(e.target.value)} required>
                    <option value="">Choose a built-in provider…</option>
                    {props.builtins.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
                  </select>
                  {activeBuiltin && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {activeBuiltin.credentialLabel}
                      {activeBuiltin.perConnection && ' — each workspace enters their own site URL and credential, so this must be Tier 2.'}
                    </p>
                  )}
                </div>
              )
            : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <input className={input} placeholder="MCP server URL" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} required />
                  <input className={input} placeholder="Auth header (Authorization)" value={form.authHeader} onChange={e => setForm({ ...form, authHeader: e.target.value })} />
                </div>
              )}

          <div className="grid gap-3 sm:grid-cols-2">
            <input
              className={`${input} ${editingId ? 'opacity-60' : ''}`}
              placeholder="slug (e.g. kie-ai)"
              value={form.slug}
              onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })}
              disabled={Boolean(editingId)}
              title={editingId ? 'The slug is fixed — workspace connections point at it.' : undefined}
              required
            />
            <input className={input} placeholder="Display name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            <select className={input} value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })}>
              <option value="tier1">Tier 1 — my account, metered &amp; billed</option>
              <option value="tier2">Tier 2 — client brings their own key</option>
            </select>
            <select className={input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <input className={input} placeholder="Short description shown to clients" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />

          {form.tier === 'tier1'
            ? (
                <>
                  {!perConnection && (
                    <div>
                      <label className="mb-1 block text-sm font-medium" htmlFor="cat-key">
                        Your API key (encrypted; never shown again)
                      </label>
                      <input
                        id="cat-key"
                        type="password"
                        className={input}
                        placeholder={editing?.hasCredential ? 'Leave blank to keep the current key' : ''}
                        value={form.credentialValue}
                        onChange={e => setForm({ ...form, credentialValue: e.target.value })}
                        required={!editing?.hasCredential}
                      />
                    </div>
                  )}

                  {perConnection && (
                    <input
                      className={input}
                      placeholder="Hint shown to the client when they connect their site"
                      value={form.authHint}
                      onChange={e => setForm({ ...form, authHint: e.target.value })}
                    />
                  )}

                  {/* ── Pricing table ── */}
                  <div className="rounded-xl border">
                    <div className="
                      flex flex-wrap items-center justify-between gap-2 border-b
                      px-3 py-2
                    "
                    >
                      <div>
                        <p className="text-sm font-medium">Pricing</p>
                        <p className="text-xs text-muted-foreground">
                          Enter what each call costs YOU. Retail is what the client is billed.
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        Markup on all
                        <input
                          type="number"
                          min="0"
                          className="
                            w-16 rounded border border-input bg-background px-2
                            py-1 text-xs
                          "
                          value={defaultMarkup}
                          onChange={e => applyMarkupToAll(e.target.value)}
                        />
                        %
                      </label>
                    </div>

                    {rows.length === 0
                      ? (
                          <p className="px-3 py-4 text-xs text-muted-foreground">
                            {kind === 'builtin'
                              ? 'Pick a provider above and its tools will appear here to price.'
                              : 'Add a row for each tool you want to meter (the tool name must match the MCP server\'s).'}
                          </p>
                        )
                      : (
                          <table className="w-full text-xs">
                            <thead className="text-left text-muted-foreground">
                              <tr>
                                <th className="p-2">Tool</th>
                                <th className="p-2">Charged per</th>
                                <th className="p-2">Your cost (USD)</th>
                                <th className="p-2">Markup %</th>
                                <th className="p-2">Client pays</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r, i) => {
                                const cost = Number(r.costUsd) || 0;
                                const retail = cost * (1 + (Number(r.markupPct) || 0) / 100);
                                return (
                                  <tr key={r.tool || i} className="border-t">
                                    <td className="p-2 font-medium">
                                      {kind === 'builtin'
                                        ? r.tool
                                        : (
                                            <input
                                              className="
                                                w-32 rounded border border-input
                                                bg-background px-2 py-1
                                              "
                                              placeholder="tool name"
                                              value={r.tool}
                                              onChange={e => setRow(i, { tool: e.target.value })}
                                            />
                                          )}
                                    </td>
                                    <td className="p-2">
                                      <select
                                        className="rounded border border-input bg-background px-1 py-1"
                                        value={r.unit}
                                        onChange={e => setRow(i, { unit: e.target.value as 'call' | 'arg' })}
                                      >
                                        <option value="call">each call</option>
                                        <option value="arg">
                                          per
                                          {' '}
                                          {r.argField || 'unit'}
                                        </option>
                                      </select>
                                    </td>
                                    <td className="p-2">
                                      <input
                                        type="number"
                                        step="0.0001"
                                        min="0"
                                        placeholder="0.00"
                                        className="
                                          w-24 rounded border border-input
                                          bg-background px-2 py-1
                                        "
                                        value={r.costUsd}
                                        onChange={e => setRow(i, { costUsd: e.target.value })}
                                      />
                                    </td>
                                    <td className="p-2">
                                      <input
                                        type="number"
                                        min="0"
                                        className="
                                          w-16 rounded border border-input
                                          bg-background px-2 py-1
                                        "
                                        value={r.markupPct}
                                        onChange={e => setRow(i, { markupPct: e.target.value })}
                                      />
                                    </td>
                                    <td className="p-2 font-medium text-green-600">
                                      {cost > 0 ? money(retail) : '—'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}

                    <div className="
                      flex items-center justify-between border-t px-3 py-2
                    "
                    >
                      <p className="text-xs text-muted-foreground">
                        Leave a cost blank to leave that tool unmetered (free to the client).
                        Set markup to 0% to pass through at wholesale.
                      </p>
                      {kind === 'http' && (
                        <button
                          type="button"
                          className="
                            shrink-0 rounded border border-white/12 px-2 py-1
                            text-xs
                          "
                          onClick={() => setRows(rs => [...rs, { tool: '', unit: 'call', argField: '', costUsd: '', markupPct: defaultMarkup }])}
                        >
                          + Add tool
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )
            : (
                <input className={input} placeholder="Where does the client get their key? (shown as a hint)" value={form.authHint} onChange={e => setForm({ ...form, authHint: e.target.value })} />
              )}

          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : saveLabel}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={reset}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="glass glass-topline relative divide-y divide-white/6">
        {props.catalog.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No plugins yet. Add Kie.ai as Tier 1 to give every workspace image and video generation.
          </p>
        )}
        {props.catalog.map(p => (
          <div key={p.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{p.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${
                  p.tier === 'tier1' ? 'bg-indigo-400/15 text-indigo-300' : 'bg-white/10 text-white/50'
                }`}
                >
                  {p.tier === 'tier1' ? 'Tier 1 · metered' : 'Tier 2 · BYO key'}
                </span>
                {p.transport === 'builtin' && (
                  <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-xs text-emerald-300">built-in</span>
                )}
                {!p.enabled && (
                  <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-xs text-amber-300">hidden</span>
                )}
                {p.category && <span className="text-xs text-muted-foreground">{p.category}</span>}
              </div>
              {p.description && <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>}
              {p.priceRules && Object.keys(p.priceRules).length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {Object.entries(p.priceRules).map(([tool, r]) => {
                    const retail = r.costUsd * (r.markup ?? 1.5);
                    return `${tool}: ${money(retail)}/${r.unit === 'arg' ? (r.argField ?? 'unit') : 'call'}`;
                  }).join(' · ')}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={() => startEdit(p)}>Edit</Button>
              <Button size="sm" variant="outline" onClick={() => toggle(p)}>
                {p.enabled ? 'Hide' : 'Show'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => del(p.id)}>Remove</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
