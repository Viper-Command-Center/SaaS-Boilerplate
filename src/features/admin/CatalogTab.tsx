'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export type PriceRule = {
  /** usage = the provider reports what it consumed (e.g. Kie credits). */
  unit: 'call' | 'arg' | 'usage';
  argField?: string;
  costUsd: number;
  markup?: number;
};

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
  /** How many API keys are in rotation (multi-key providers). */
  keyCount?: number;
  priceRules: Record<string, PriceRule> | null;
};

export type BuiltinProvider = {
  slug: string;
  name: string;
  description: string;
  credentialLabel: string;
  perConnection?: boolean;
  /** Accepts up to 20 keys, round-robined with failover. */
  multiKey?: boolean;
  /** Needs no credential at all — rides platform infrastructure. */
  noCredential?: boolean;
  /** Provider reports its own consumption — one rate prices every model. */
  usageMetering?: {
    unitLabel: string;
    defaultUnitCostUsd: number;
    note?: string;
  } | null;
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

type Row = { tool: string; unit: 'call' | 'arg' | 'usage'; argField: string; costUsd: string; markupPct: string };

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
  /** Usage-priced providers (Kie.ai): our cost per reported unit. */
  const [unitCost, setUnitCost] = useState('');

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
        unit: (r?.unit ?? (meteredArg ? 'arg' : 'call')) as Row['unit'],
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
    setUnitCost('');
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
    if (p.usageMetering) {
      // The provider reports what it consumed → one rate, no per-tool table.
      setUnitCost(String(p.usageMetering.defaultUnitCostUsd));
      setRows([]);
    } else {
      setUnitCost('');
      setRows(rowsFromRules(null, p.tools));
    }
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

    if (bp?.usageMetering) {
      const stored = Object.values(p.priceRules ?? {}).find(r => r.unit === 'usage');
      setUnitCost(String(stored?.costUsd ?? bp.usageMetering.defaultUnitCostUsd));
      if (stored?.markup !== undefined) {
        setDefaultMarkup(String(Math.round((stored.markup - 1) * 100)));
      }
      setRows([]);
    } else {
      setUnitCost('');
      setRows(rowsFromRules(p.priceRules, bp?.tools));
    }
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

    // Usage-priced provider: one rate, applied to every tool. The provider
    // tells us how many units each job burned, so this prices all its models.
    const usage = props.builtins.find(b => b.slug === form.provider)?.usageMetering;
    if (kind === 'builtin' && usage) {
      const cost = Number(unitCost);
      if (!Number.isFinite(cost) || cost <= 0) {
        return out;
      }
      const markup = 1 + (Number(defaultMarkup) || 0) / 100;
      for (const t of props.builtins.find(b => b.slug === form.provider)?.tools ?? []) {
        out[t.name] = { unit: 'usage', costUsd: cost, markup };
      }
      return out;
    }

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
  // No platform key field for these: per-site providers (WordPress) take the
  // client's own credential, and noCredential providers (AgentCore browser)
  // authenticate with the platform's AWS keys.
  const perConnection = kind === 'builtin'
    && (Boolean(activeBuiltin?.perConnection) || Boolean(activeBuiltin?.noCredential));
  const multiKey = kind === 'builtin' && Boolean(activeBuiltin?.multiKey);
  const usage = kind === 'builtin' ? activeBuiltin?.usageMetering ?? null : null;
  const retailPerUnit = (Number(unitCost) || 0) * (1 + (Number(defaultMarkup) || 0) / 100);

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
                      {activeBuiltin.description}
                      {activeBuiltin.perConnection && ' Each workspace enters their own site URL and credential, so set this to Tier 2.'}
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
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="cat-slug">
                Slug
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (internal id — can&apos;t change later)
                </span>
              </label>
              <input
                id="cat-slug"
                className={`${input} ${editingId ? 'opacity-60' : ''}`}
                placeholder="kie-ai"
                value={form.slug}
                onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                disabled={Boolean(editingId)}
                title={editingId ? 'The slug is fixed — workspace connections point at it.' : undefined}
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="cat-name">Display name</label>
              <input id="cat-name" className={input} placeholder="Kie.ai" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="cat-tier">Tier</label>
              <select id="cat-tier" className={input} value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })}>
                <option value="tier1">Tier 1 — my account, metered &amp; billed</option>
                <option value="tier2">Tier 2 — client brings their own key</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="cat-cat">Category</label>
              <select id="cat-cat" className={input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="cat-desc">Description shown to clients</label>
            <input id="cat-desc" className={input} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>

          {form.tier === 'tier1'
            ? (
                <>
                  {!perConnection && (
                    <div>
                      <label className="mb-1 block text-sm font-medium" htmlFor="cat-key">
                        {multiKey ? 'Your API keys — one per line, up to 20' : 'Your API key'}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          (encrypted; never shown again)
                        </span>
                      </label>
                      {multiKey
                        ? (
                            <textarea
                              id="cat-key"
                              rows={4}
                              className={`${input} font-mono text-xs`}
                              placeholder={editing?.hasCredential
                                ? `Leave blank to keep the ${editing.keyCount ?? 0} key(s) already stored`
                                : 'sk-key-one\nsk-key-two\nsk-key-three'}
                              value={form.credentialValue}
                              onChange={e => setForm({ ...form, credentialValue: e.target.value })}
                              required={!editing?.hasCredential}
                            />
                          )
                        : (
                            <input
                              id="cat-key"
                              type="password"
                              className={input}
                              placeholder={editing?.hasCredential ? 'Leave blank to keep the current key' : ''}
                              value={form.credentialValue}
                              onChange={e => setForm({ ...form, credentialValue: e.target.value })}
                              required={!editing?.hasCredential}
                            />
                          )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {activeBuiltin?.credentialLabel ?? 'The key this plugin authenticates with.'}
                        {multiKey && ' Calls round-robin across the keys and fail over automatically if one is rate-limited, blocked or out of credit.'}
                        {editing?.hasCredential && multiKey && ` Currently ${editing.keyCount ?? 0} key(s) in rotation.`}
                      </p>
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

                  {/* ── Usage-priced provider: one rate covers every model ── */}
                  {usage
                    ? (
                        <div className="rounded-xl border">
                          <div className="border-b px-3 py-2">
                            <p className="text-sm font-medium">Pricing</p>
                            <p className="text-xs text-muted-foreground">{usage.note}</p>
                          </div>
                          <div className="
                            grid gap-3 px-3 py-3
                            sm:grid-cols-3
                          "
                          >
                            <div>
                              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="cat-unit-cost">
                                Your cost per
                                {' '}
                                {usage.unitLabel}
                                {' '}
                                (USD)
                              </label>
                              <input
                                id="cat-unit-cost"
                                type="number"
                                step="0.0001"
                                min="0"
                                className={input}
                                value={unitCost}
                                onChange={e => setUnitCost(e.target.value)}
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="cat-unit-markup">
                                Markup %
                              </label>
                              <input
                                id="cat-unit-markup"
                                type="number"
                                min="0"
                                className={input}
                                value={defaultMarkup}
                                onChange={e => setDefaultMarkup(e.target.value)}
                              />
                            </div>
                            <div>
                              <p className="mb-1 text-xs text-muted-foreground">Client pays per {usage.unitLabel}</p>
                              <p className="grad-text py-2 text-lg font-semibold">
                                {retailPerUnit > 0 ? `$${retailPerUnit.toFixed(4)}` : '—'}
                              </p>
                            </div>
                          </div>
                          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                            Every job is billed on the
                            {' '}
                            {usage.unitLabel}
                            s it actually consumed, reported by the provider — so a
                            $0.02 image and a $4 video are both priced correctly, and
                            failed jobs cost the client nothing. Set markup to 0% to pass
                            through at wholesale.
                          </p>
                        </div>
                      )
                    : (

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
                      )}
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
                {(p.keyCount ?? 0) > 1 && (
                  <span className="rounded bg-sky-400/15 px-1.5 py-0.5 text-xs text-sky-300">
                    {p.keyCount}
                    {' '}
                    keys in rotation
                  </span>
                )}
                {p.category && <span className="text-xs text-muted-foreground">{p.category}</span>}
              </div>
              {p.description && <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>}
              {(() => {
                const rules = Object.entries(p.priceRules ?? {});
                if (rules.length === 0) {
                  return null;
                }
                const usageRule = rules.find(([, r]) => r.unit === 'usage')?.[1];
                const unitLabel = props.builtins.find(b => b.slug === p.provider)?.usageMetering?.unitLabel ?? 'unit';
                return (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {usageRule
                      ? `Usage-priced · ${money(usageRule.costUsd * (usageRule.markup ?? 1.5))} per ${unitLabel} (cost ${money(usageRule.costUsd)} + ${Math.round(((usageRule.markup ?? 1.5) - 1) * 100)}%)`
                      : rules.map(([tool, r]) => {
                          const retail = r.costUsd * (r.markup ?? 1.5);
                          return `${tool}: ${money(retail)}/${r.unit === 'arg' ? (r.argField ?? 'unit') : 'call'}`;
                        }).join(' · ')}
                  </p>
                );
              })()}
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
