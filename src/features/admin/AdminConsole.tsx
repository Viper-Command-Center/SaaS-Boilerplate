'use client';

import type { BuiltinProvider, Plugin } from '@/features/admin/CatalogTab';
import type { AdminUser, Workspace as WsOption } from '@/features/admin/UsersTab';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CatalogTab } from '@/features/admin/CatalogTab';
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

const money = (n: number) => `$${n.toFixed(2)}`;

export const AdminConsole = () => {
  const [tab, setTab] = useState<'workspaces' | 'users' | 'catalog'>('workspaces');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [totals, setTotals] = useState({ cost: 0, billed: 0, margin: 0, users: 0, workspaces: 0 });
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [wsOptions, setWsOptions] = useState<WsOption[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [catalog, setCatalog] = useState<Plugin[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinProvider[]>([]);
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
    fetch('/api/admin/catalog').then(r => r.json()).then((d) => {
      setCatalog(d.catalog ?? []);
      setBuiltins(d.builtinProviders ?? []);
    }).catch(() => {});
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

      {tab === 'catalog' && <CatalogTab catalog={catalog} builtins={builtins} reload={reload} />}
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
