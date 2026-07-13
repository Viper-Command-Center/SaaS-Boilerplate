'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type Approval = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
  requestedAt: string;
  result: { text?: string; error?: string } | null;
};

/**
 * Approvals inbox — every side-effecting tool call the agent proposes lands
 * here until a human approves or rejects it. Approving executes immediately.
 */
export const ApprovalsPanel = (props: { tenantSlug: string }) => {
  const [items, setItems] = useState<Approval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch(`/api/approvals?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { approvals: [] }))
      .then(data => setItems(data.approvals ?? []))
      .catch(() => {});
  }, [props.tenantSlug]);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 15_000);
    return () => clearInterval(interval);
  }, [reload]);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    await fetch(`/api/approvals/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).catch(() => {});
    setBusyId(null);
    reload();
  };

  const pending = items.filter(i => i.status === 'pending');
  const decided = items.filter(i => i.status !== 'pending').slice(0, 5);

  const badge = (status: string) => {
    const styles: Record<string, string> = {
      executed: 'text-green-600',
      approved: 'text-green-600',
      rejected: 'text-muted-foreground',
      failed: 'text-red-600',
      pending: 'text-amber-600',
    };
    return <span className={`text-xs font-medium ${styles[status] ?? ''}`}>{status}</span>;
  };

  return (
    <div className="glass glass-topline relative">
      <div className="border-b border-white/8 px-4 py-3">
        <span className="text-sm font-semibold">
          Approvals
          {pending.length > 0 ? ` (${pending.length} pending)` : ''}
        </span>
        <p className="text-xs text-muted-foreground">
          Side-effecting agent actions wait here for your sign-off.
        </p>
      </div>

      <div className="divide-y">
        {items.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Nothing waiting. When the agent proposes an action that needs
            approval, it shows up here.
          </p>
        )}

        {pending.map(item => (
          <div key={item.id} className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{item.toolName}</span>
              {badge(item.status)}
            </div>
            <pre className="
              max-h-32 overflow-auto rounded bg-muted p-2 text-xs
            "
            >
              {JSON.stringify(item.args, null, 2)}
            </pre>
            <div className="flex gap-2">
              <Button size="sm" disabled={busyId === item.id} onClick={() => decide(item.id, 'approve')}>
                {busyId === item.id ? 'Working…' : 'Approve & run'}
              </Button>
              <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => decide(item.id, 'reject')}>
                Reject
              </Button>
            </div>
          </div>
        ))}

        {decided.map(item => (
          <div key={item.id} className="flex items-center justify-between gap-2 px-4 py-2">
            <span className="truncate text-xs text-muted-foreground">{item.toolName}</span>
            <div className="flex items-center gap-2">
              {item.result?.error && <span className="max-w-56 truncate text-xs text-red-600">{item.result.error}</span>}
              {badge(item.status)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
