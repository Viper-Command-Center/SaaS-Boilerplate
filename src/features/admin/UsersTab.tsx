'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export type AdminUser = {
  id: string;
  email: string;
  firstName: string | null;
  isAdmin: boolean;
  twoFactorEnabled: boolean;
  deletedAt: string | null;
  memberships: Array<{ tenantId: string; role: string; tenantName: string; tenantSlug: string }>;
};

export type Workspace = { id: string; name: string; slug: string };

const ROLES = ['viewer', 'editor', 'admin', 'owner'];

export const UsersTab = (props: {
  users: AdminUser[];
  workspaces: Workspace[];
  emailConfigured: boolean;
  reload: () => void;
}) => {
  const [showNew, setShowNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', firstName: '', tenantId: '', role: 'viewer', isAdmin: false });

  const input = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.email,
        firstName: form.firstName || undefined,
        isAdmin: form.isAdmin,
        tenantId: form.tenantId || undefined,
        role: form.tenantId ? form.role : undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not create the user.');
      return;
    }
    setNotice(data.emailed
      ? `Invite emailed to ${form.email}.`
      : `User created. Temporary password (share securely): ${data.tempPassword}`);
    setForm({ email: '', firstName: '', tenantId: '', role: 'viewer', isAdmin: false });
    setShowNew(false);
    props.reload();
  };

  const patch = async (userId: string, patchBody: Record<string, unknown>, successMsg?: string) => {
    setError(null);
    setNotice(null);
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...patchBody }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Update failed.');
      return;
    }
    if (data?.tempPassword) {
      setNotice(`New temporary password (share securely): ${data.tempPassword}`);
    } else if (successMsg) {
      setNotice(successMsg);
    }
    props.reload();
  };

  const hardDelete = async (u: AdminUser) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Permanently delete ${u.email}? This removes their memberships and conversations.`)) {
      return;
    }
    await fetch(`/api/admin/users?userId=${encodeURIComponent(u.id)}`, { method: 'DELETE' }).catch(() => {});
    props.reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {props.emailConfigured
            ? 'New users are emailed an invite with a temporary password.'
            : 'Email is not configured — you\'ll get a temporary password to share manually.'}
        </p>
        <Button size="sm" variant="outline" onClick={() => setShowNew(s => !s)}>
          {showNew ? 'Cancel' : 'Add user'}
        </Button>
      </div>

      {notice && <p className="rounded-md bg-muted p-3 text-sm">{notice}</p>}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      {showNew && (
        <form onSubmit={create} className="space-y-3 rounded-lg border bg-background p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={input} type="email" placeholder="email@client.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
            <input className={input} placeholder="First name" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} />
            <select className={input} value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })}>
              <option value="">No workspace yet</option>
              {props.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select className={input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} disabled={!form.tenantId}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isAdmin} onChange={e => setForm({ ...form, isAdmin: e.target.checked })} />
            Platform admin (full access to everything)
          </label>
          <Button type="submit" size="sm">Create user &amp; send invite</Button>
        </form>
      )}

      <div className="overflow-x-auto rounded-lg border bg-background">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">User</th>
              <th className="p-3">Workspaces</th>
              <th className="p-3">2FA</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.users.map(u => (
              <tr key={u.id} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">
                    {u.email}
                    {u.isAdmin && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">admin</span>}
                    {u.deletedAt && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">disabled</span>}
                  </div>
                  {u.firstName && <div className="text-xs text-muted-foreground">{u.firstName}</div>}
                </td>

                <td className="p-3">
                  <div className="space-y-1">
                    {u.memberships.map(m => (
                      <div key={m.tenantId} className="flex items-center gap-2 text-xs">
                        <span>
                          {m.tenantName}
                          {' · '}
                        </span>
                        <select
                          className="rounded border border-input bg-background px-1 py-0.5 text-xs"
                          value={m.role}
                          onChange={e => patch(u.id, { addMembership: { tenantId: m.tenantId, role: e.target.value } }, 'Role updated.')}
                        >
                          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-red-600"
                          onClick={() => patch(u.id, { removeMembership: { tenantId: m.tenantId } }, 'Removed from workspace.')}
                        >
                          remove
                        </button>
                      </div>
                    ))}
                    <select
                      className="
                        rounded border border-input bg-background px-1 py-0.5
                        text-xs text-muted-foreground
                      "
                      value=""
                      onChange={e => e.target.value && patch(u.id, { addMembership: { tenantId: e.target.value, role: 'viewer' } }, 'Added to workspace.')}
                    >
                      <option value="">+ add to workspace…</option>
                      {props.workspaces
                        .filter(w => !u.memberships.some(m => m.tenantId === w.id))
                        .map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                </td>

                <td className="p-3 text-xs">
                  {u.twoFactorEnabled
                    ? <span className="text-green-600">enabled</span>
                    : <span className="text-muted-foreground">off</span>}
                </td>

                <td className="p-3">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => patch(u.id, { isAdmin: !u.isAdmin }, 'Admin access updated.')}>
                      {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => patch(u.id, { resetPassword: true })}>
                      Reset password
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => patch(u.id, { deleted: !u.deletedAt }, 'Status updated.')}>
                      {u.deletedAt ? 'Restore' : 'Disable'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => hardDelete(u)}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
