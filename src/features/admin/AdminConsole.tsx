'use client';

import type { AdminUser, Workspace as WsOption } from '@/features/admin/UsersTab';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { UsersTab } from '@/features/admin/UsersTab';

type Workspace = {
  id: string;
  name: string;
  slug: string;
  planName: string;
  paused: boolean;
  monthlyBudgetUsd: number;
  dailyCapUsd: number;
  members: number;
  monthCostUsd: number;
  monthBilledUsd: number;
  marginUsd: number;
  todayCostUsd: number;
  inputTokens: number;
  outputTokens: number;
};

type Plugin = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  tier: string;
  url: string | null;
  authHeader: string | null;
  enabled: boolean;
  hasCredential: boolean;
  priceRules: Record<string, { unit: string; costUsd: number; argField?: string; markup?: number }> | null;
};

const money = (n: number) => `$${n.toFixed(2)}`;

export const AdminConsole = () => {
  const [tab, setTab] = useState<'workspaces' | 'users' | 'catalog'>('workspaces');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [totals, setTotals] = useState({ cost: 0, billed: 0, margin: 0, users: 0, workspaces: 0 });
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [wsOptions, setWsOptions] = useState<WsOption[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [catalog, setCatalog] = useState<Plugin[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    fetch('/api/admin/overview').then(r => r.json()).then((d) => {
      setWorkspaces(d.workspaces ?? []);
      setTotals(d.totals ?? { cost: 0, billed: 0, margin: 0, users: 0, workspaces: 0 });
    }).catch(() => {});
    fetch('/api/admin/users').then(r => r.json()).then((d) => {
      setUsers(d.users ?? []);
      setWsOptions(d.workspaces ?? []);
      setEmailConfigured(Boolean(d.emailConfigured));
    }).catch(() => {});
    fetch('/api/admin/catalog').then(r => r.json()).then(d => setCatalog(d.catalog ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const i = setInterval(reload, 30_000);
    return () => clearInterval(i);
  }, [reload]);

  const patchWorkspace = async (tenantId: string, patch: Record<string, unknown>) => {
    setBusy(true);
    await fetch('/api/admin/overview', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, ...patch }),
    }).catch(() => {});
    setBusy(false);
    reload();
  };

  const tabClass = (t: string) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`;

  return (
    <div className="space-y-6">
      {/* Totals */}
      <div className="
        grid gap-4
        sm:grid-cols-2
        lg:grid-cols-4
      "
      >
        <Stat label="Revenue (billed, MTD)" value={money(totals.billed)} />
        <Stat label="AI + plugin cost (MTD)" value={money(totals.cost)} />
        <Stat label="Margin (MTD)" value={money(totals.margin)} accent={totals.margin >= 0} />
        <Stat label="Workspaces · users" value={`${totals.workspaces} · ${totals.users}`} />
      </div>

      <div className="flex gap-2">
        <button type="button" className={tabClass('workspaces')} onClick={() => setTab('workspaces')}>Workspaces</button>
        <button type="button" className={tabClass('users')} onClick={() => setTab('users')}>Users</button>
        <button type="button" className={tabClass('catalog')} onClick={() => setTab('catalog')}>Plugin catalog</button>
      </div>

      {tab === 'workspaces' && (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Workspace</th>
                <th className="p-3">Plan</th>
                <th className="p-3">Cost MTD</th>
                <th className="p-3">Billed MTD</th>
                <th className="p-3">Margin</th>
                <th className="p-3">Today / cap</th>
                <th className="p-3">Daily cap</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => {
                const overCap = w.dailyCapUsd > 0 && w.todayCostUsd >= w.dailyCapUsd;
                return (
                  <tr key={w.id} className="border-t">
                    <td className="p-3">
                      <div className="font-medium">{w.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {w.slug}
                        {' · '}
                        {w.members}
                        {' members'}
                      </div>
                    </td>
                    <td className="p-3">{w.planName}</td>
                    <td className="p-3">{money(w.monthCostUsd)}</td>
                    <td className="p-3">{money(w.monthBilledUsd)}</td>
                    <td className={`p-3 font-medium ${w.marginUsd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {money(w.marginUsd)}
                    </td>
                    <td className={`p-3 ${overCap ? 'font-semibold text-red-600' : ''}`}>
                      {money(w.todayCostUsd)}
                    </td>
                    <td className="p-3">
                      <input
                        type="number"
                        step="1"
                        min="0"
                        defaultValue={w.dailyCapUsd}
                        onBlur={e => patchWorkspace(w.id, { dailyCapUsd: Number(e.target.value) })}
                        className="
                          w-20 rounded border border-input bg-background px-2
                          py-1 text-sm
                        "
                      />
                    </td>
                    <td className="p-3">
                      <Button
                        size="sm"
                        variant={w.paused ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={() => patchWorkspace(w.id, { paused: !w.paused })}
                      >
                        {w.paused ? 'Resume' : 'Pause agent'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {workspaces.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-muted-foreground">No workspaces yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'users' && (
        <UsersTab
          users={users}
          workspaces={wsOptions}
          emailConfigured={emailConfigured}
          reload={reload}
        />
      )}

      {tab === 'catalog' && <CatalogTab catalog={catalog} reload={reload} />}
    </div>
  );
};

const Stat = ({ label, value, accent }: { label: string; value: string; accent?: boolean }) => (
  <div className="rounded-lg border bg-background p-4">
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className={`mt-1 text-2xl font-bold ${accent === undefined ? '' : accent ? 'text-green-600' : 'text-red-600'}`}>
      {value}
    </div>
  </div>
);

const CatalogTab = ({ catalog, reload }: { catalog: Plugin[]; reload: () => void }) => {
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    slug: '',
    name: '',
    description: '',
    category: 'media',
    tier: 'tier2',
    url: '',
    authHeader: 'Authorization',
    authHint: '',
    credentialValue: '',
    priceRulesText: '',
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let priceRules;
    if (form.tier === 'tier1' && form.priceRulesText.trim()) {
      try {
        priceRules = JSON.parse(form.priceRulesText);
      } catch {
        setError('Price rules must be valid JSON.');
        return;
      }
    }
    const res = await fetch('/api/admin/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: form.slug,
        name: form.name,
        description: form.description || undefined,
        category: form.category || undefined,
        tier: form.tier,
        url: form.url,
        authHeader: form.authHeader || undefined,
        authHint: form.authHint || undefined,
        credentialValue: form.tier === 'tier1' ? form.credentialValue : undefined,
        priceRules,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not save.');
      return;
    }
    setShow(false);
    setForm({ ...form, slug: '', name: '', url: '', credentialValue: '', priceRulesText: '' });
    reload();
  };

  const del = async (id: string) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Remove this plugin from the catalog?')) {
      return;
    }
    await fetch(`/api/admin/catalog?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    reload();
  };

  const input = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <span className="text-sm font-semibold">Plugin catalog</span>
          <p className="text-xs text-muted-foreground">
            Tier 1 = your account, metered and billed to the client. Tier 2 = client brings their own key.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShow(s => !s)}>{show ? 'Cancel' : 'Add plugin'}</Button>
      </div>

      {show && (
        <form onSubmit={submit} className="space-y-3 border-b p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={input} placeholder="slug (e.g. kie-ai)" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })} required />
            <input className={input} placeholder="Name (e.g. Kie.ai media)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            <input className={input} placeholder="MCP server URL" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} required />
            <select className={input} value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })}>
              <option value="tier2">Tier 2 — client brings their own key</option>
              <option value="tier1">Tier 1 — our account, metered + billed</option>
            </select>
            <select className={input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {['media', 'seo', 'social', 'ads', 'analytics', 'dev', 'data', 'other'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input className={input} placeholder="Auth header (default Authorization)" value={form.authHeader} onChange={e => setForm({ ...form, authHeader: e.target.value })} />
          </div>
          <input className={input} placeholder="Short description shown to clients" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />

          {form.tier === 'tier1'
            ? (
                <>
                  <input className={input} type="password" placeholder="Platform credential value (sealed in vault, e.g. Bearer sk_…)" value={form.credentialValue} onChange={e => setForm({ ...form, credentialValue: e.target.value })} />
                  <textarea
                    className={`${input} h-24 font-mono text-xs`}
                    placeholder={'Price rules JSON, e.g.\n{"generate_video": {"unit":"arg","argField":"seconds","costUsd":0.05,"markup":2},\n "generate_image": {"unit":"call","costUsd":0.01}}'}
                    value={form.priceRulesText}
                    onChange={e => setForm({ ...form, priceRulesText: e.target.value })}
                  />
                </>
              )
            : (
                <input className={input} placeholder="Auth hint for the client (e.g. 'Bearer sk_… — get it at dataforseo.com')" value={form.authHint} onChange={e => setForm({ ...form, authHint: e.target.value })} />
              )}

          {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
          <Button type="submit" size="sm">Save plugin</Button>
        </form>
      )}

      <div className="divide-y">
        {catalog.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">No plugins yet. Add the ones you hold accounts for (Tier 1) and the ones clients bring keys for (Tier 2).</p>}
        {catalog.map(p => (
          <div key={p.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${p.tier === 'tier1' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>
                  {p.tier === 'tier1' ? 'Tier 1 · metered' : 'Tier 2 · BYO key'}
                </span>
                {p.category && <span className="text-xs text-muted-foreground">{p.category}</span>}
              </div>
              {p.description && <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>}
              <p className="truncate text-xs text-muted-foreground">{p.url}</p>
              {p.tier === 'tier1' && p.priceRules && Object.keys(p.priceRules).length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Priced tools:
                  {' '}
                  {Object.keys(p.priceRules).join(', ')}
                </p>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => del(p.id)}>Remove</Button>
          </div>
        ))}
      </div>
    </div>
  );
};
