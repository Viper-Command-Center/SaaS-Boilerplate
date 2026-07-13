'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

type Member = { userId: string; email: string; firstName: string | null; role: string };

/**
 * Workspace administration: members with roles (owner/admin), and — for the
 * platform admin — creating new client workspaces. When adding a member who
 * has no account yet, a one-time generated password is shown to hand over.
 */
export const WorkspacePanel = (props: {
  tenantSlug: string;
  canManageMembers: boolean;
  isPlatformAdmin: boolean;
}) => {
  const router = useRouter();
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [role, setRole] = useState('viewer');
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [wsName, setWsName] = useState('');
  const [wsSlug, setWsSlug] = useState('');
  const [wsError, setWsError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!props.canManageMembers) {
      return;
    }
    fetch(`/api/tenants/${encodeURIComponent(props.tenantSlug)}/members`)
      .then(r => (r.ok ? r.json() : { members: [] }))
      .then(data => setMembers(data.members ?? []))
      .catch(() => {});
  }, [props.tenantSlug, props.canManageMembers]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOneTimePassword(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(props.tenantSlug)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, firstName: firstName || undefined, role }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? 'Could not add the member.');
      } else {
        if (data?.generatedPassword) {
          setOneTimePassword(data.generatedPassword);
        }
        setEmail('');
        setFirstName('');
        reload();
      }
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (m: Member) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove ${m.email} from this workspace?`)) {
      return;
    }
    await fetch(`/api/tenants/${encodeURIComponent(props.tenantSlug)}/members?userId=${encodeURIComponent(m.userId)}`, {
      method: 'DELETE',
    }).catch(() => {});
    reload();
  };

  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setWsError(null);
    const res = await fetch('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: wsName, slug: wsSlug }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (!res?.ok) {
      setWsError(data?.error ?? 'Could not create the workspace.');
      return;
    }
    setWsName('');
    setWsSlug('');
    router.push(`/dashboard?t=${encodeURIComponent(data.tenant.slug)}`);
    router.refresh();
  };

  /**
   * Deleting a workspace destroys its conversations, tools, panels, usage and
   * files (in R2 too) — so it asks for the slug to be typed, not just an OK.
   */
  const deleteWorkspace = async () => {
    // eslint-disable-next-line no-alert
    const typed = window.prompt(
      `This permanently deletes the "${props.tenantSlug}" workspace: members, chat history, tools, panels, scheduled tasks and every stored file.\n\nType the slug to confirm:`,
    );
    if (typed !== props.tenantSlug) {
      if (typed !== null) {
        setWsError('The slug didn\'t match — nothing was deleted.');
      }
      return;
    }
    const url = `/api/tenants?slug=${encodeURIComponent(props.tenantSlug)}&confirm=${encodeURIComponent(typed)}`;
    const res = await fetch(url, { method: 'DELETE' }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (!res?.ok) {
      setWsError(data?.error ?? 'Could not delete the workspace.');
      return;
    }
    router.push('/dashboard');
    router.refresh();
  };

  const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  if (!props.canManageMembers && !props.isPlatformAdmin) {
    return null;
  }

  return (
    <div className="glass relative">
      <div className="border-b border-white/8 px-4 py-3">
        <span className="text-sm font-semibold">Workspace</span>
        <p className="text-xs text-muted-foreground">
          Members, roles and — for the platform admin — new client workspaces.
        </p>
      </div>

      {props.canManageMembers && (
        <div className="border-b p-4">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Members</p>
          <div className="space-y-1">
            {members.map(m => (
              <div key={m.userId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">
                  {m.email}
                  <span className="ml-2 text-xs text-muted-foreground">{m.role}</span>
                </span>
                <Button variant="outline" size="sm" onClick={() => removeMember(m)}>Remove</Button>
              </div>
            ))}
          </div>

          <form onSubmit={addMember} className="mt-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <input className={inputClass} type="email" placeholder="client@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
              <input className={inputClass} placeholder="First name" value={firstName} onChange={e => setFirstName(e.target.value)} />
              <select className={inputClass} value={role} onChange={e => setRole(e.target.value)}>
                <option value="viewer">viewer — dashboards only</option>
                <option value="editor">editor — chat + approvals</option>
                <option value="admin">admin — manage tools/members</option>
                <option value="owner">owner — full control</option>
              </select>
            </div>
            {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
            {oneTimePassword && (
              <p className="rounded bg-muted p-2 text-xs">
                Account created. One-time password (share securely, shown once):
                {' '}
                <code className="font-semibold">{oneTimePassword}</code>
              </p>
            )}
            <Button type="submit" size="sm" disabled={busy}>{busy ? 'Adding…' : 'Add member'}</Button>
          </form>
        </div>
      )}

      {props.isPlatformAdmin && (
        <form onSubmit={createWorkspace} className="space-y-2 p-4">
          <p className="text-xs font-semibold text-muted-foreground">New client workspace</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={inputClass} placeholder="Name (e.g. BargainBalloons)" value={wsName} onChange={e => setWsName(e.target.value)} required />
            <input className={inputClass} placeholder="slug (e.g. bargainballoons)" value={wsSlug} onChange={e => setWsSlug(e.target.value.toLowerCase())} required pattern="[a-z0-9-]+" />
          </div>
          {wsError && <p className="text-xs text-red-600" role="alert">{wsError}</p>}
          <Button type="submit" size="sm" variant="outline">Create workspace</Button>
        </form>
      )}

      {props.isPlatformAdmin && (
        <div className="
          flex flex-wrap items-center justify-between gap-2 border-t
          border-white/8 p-4
        "
        >
          <div>
            <p className="text-xs font-semibold text-rose-300">Danger zone</p>
            <p className="text-xs text-muted-foreground">
              Delete
              {' '}
              <strong>{props.tenantSlug}</strong>
              {' '}
              and everything in it — chat, tools, panels, files. Not reversible.
            </p>
          </div>
          <button
            type="button"
            onClick={deleteWorkspace}
            className="
              rounded-md border border-rose-400/30 px-3 py-1.5 text-xs
              font-medium text-rose-300
              hover:bg-rose-400/10
            "
          >
            Delete workspace
          </button>
        </div>
      )}
    </div>
  );
};
