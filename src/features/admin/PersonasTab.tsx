'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/features/agent/AgentAvatar';

export type AdminPersona = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  role: string | null;
  personality: string;
  avatarUrl: string | null;
  accent: string | null;
  enabled: boolean;
  workspaces: Array<{ name: string; slug: string }>;
};

const ACCENTS = ['indigo', 'violet', 'fuchsia', 'emerald', 'amber', 'rose', 'sky', 'slate'];

const EMPTY = {
  name: '',
  tagline: '',
  role: '',
  personality: '',
  avatarUrl: '',
  accent: 'indigo',
};

/**
 * Create and edit AI employees.
 *
 * Assignment lives in each workspace's own Employee panel — this tab is only
 * about who exists. Keeping the two apart matters: an owner choosing which
 * employee works their account is a client decision, while inventing a new one
 * is a platform decision, and collapsing them would let any workspace owner
 * add personas that show up in everyone else's picker.
 */
export const PersonasTab = () => {
  const [personas, setPersonas] = useState<AdminPersona[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/admin/personas')
      .then(r => (r.ok ? r.json() : { personas: [] }))
      .then(d => setPersonas(d.personas ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reset = () => {
    setForm({ ...EMPTY });
    setEditing(null);
    setError('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await fetch('/api/admin/personas', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { id: editing, ...form } : form),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? 'Could not save.');
        return;
      }
      setNotice(editing ? `${form.name} updated.` : `${form.name} is now available in every workspace picker.`);
      reset();
      load();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const edit = (p: AdminPersona) => {
    setEditing(p.id);
    setError('');
    setNotice('');
    setForm({
      name: p.name,
      tagline: p.tagline ?? '',
      role: p.role ?? '',
      personality: p.personality,
      avatarUrl: p.avatarUrl ?? '',
      accent: p.accent ?? 'indigo',
    });
  };

  const toggle = async (p: AdminPersona) => {
    setNotice('');
    await fetch('/api/admin/personas', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, enabled: !p.enabled }),
    });
    load();
  };

  const input = 'w-full rounded-md border border-white/12 bg-white/5 px-3 py-2 text-sm text-white/90 outline-none focus:border-indigo-400/50';
  const label = 'mb-1 block text-xs font-medium text-white/60';

  return (
    <div className="space-y-6">
      {/* ── Create / edit ── */}
      <form onSubmit={submit} className="glass space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold text-white">
            {editing ? 'Edit AI employee' : 'New AI employee'}
          </h2>
          <p className="mt-1 text-xs text-white/45">
            A name, a face and a manner. Every employee has identical tools,
            approvals and spend limits — this changes voice, never permission.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="p-name">Name</label>
            <input
              id="p-name"
              className={input}
              required
              maxLength={60}
              placeholder="Noah"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className={label} htmlFor="p-role">Role</label>
            <input
              id="p-role"
              className={input}
              maxLength={60}
              placeholder="ops"
              value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}
            />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="p-tagline">Tagline</label>
          <input
            id="p-tagline"
            className={input}
            maxLength={160}
            placeholder="Calm, methodical church-web operator"
            value={form.tagline}
            onChange={e => setForm({ ...form, tagline: e.target.value })}
          />
          <p className="mt-1 text-[11px] text-white/35">One line, shown in the picker.</p>
        </div>

        <div>
          <label className={label} htmlFor="p-personality">Personality</label>
          <textarea
            id="p-personality"
            className={`${input} min-h-32 resize-y`}
            required
            minLength={20}
            maxLength={4000}
            placeholder="Write it in the second person — &quot;You are patient and precise…&quot;. Describe how they talk, what they care about, and what they refuse to do sloppily."
            value={form.personality}
            onChange={e => setForm({ ...form, personality: e.target.value })}
          />
          <p className="mt-1 text-[11px] text-white/35">
            Woven into the system prompt. It cannot loosen a guardrail — approvals and
            workspace boundaries apply identically whatever this says.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="p-avatar">Avatar URL</label>
            <input
              id="p-avatar"
              className={input}
              maxLength={2000}
              placeholder="https://… (optional)"
              value={form.avatarUrl}
              onChange={e => setForm({ ...form, avatarUrl: e.target.value })}
            />
          </div>
          <div>
            <label className={label} htmlFor="p-accent">Accent</label>
            <select
              id="p-accent"
              className={input}
              value={form.accent}
              onChange={e => setForm({ ...form, accent: e.target.value })}
            >
              {ACCENTS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-white/35">Used for initials when there is no image.</p>
          </div>
        </div>

        {error && <p className="text-sm text-rose-300" role="alert">{error}</p>}
        {notice && <p className="text-sm text-emerald-300">{notice}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create employee'}
          </Button>
          {editing && (
            <Button type="button" variant="outline" onClick={reset}>Cancel</Button>
          )}
        </div>
      </form>

      {/* ── Gallery ── */}
      <div className="glass p-5">
        <h2 className="mb-4 text-sm font-semibold text-white">
          AI employees
          <span className="ml-2 text-xs font-normal text-white/40">{personas.length}</span>
        </h2>

        {personas.length === 0 && (
          <p className="text-sm text-white/45">None yet. Create the first one above.</p>
        )}

        <div className="space-y-3">
          {personas.map(p => (
            <div
              key={p.id}
              className={`flex flex-wrap items-start gap-4 rounded-xl border border-white/8 p-4 ${p.enabled ? '' : 'opacity-50'}`}
            >
              <AgentAvatar name={p.name} avatarUrl={p.avatarUrl} accent={p.accent ?? 'indigo'} size={40} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{p.name}</span>
                  {p.role && <span className="text-xs text-white/40">{p.role}</span>}
                  {!p.enabled && <span className="text-[11px] text-amber-300/80">retired</span>}
                </div>
                {p.tagline && <p className="mt-0.5 text-sm text-white/55">{p.tagline}</p>}

                {/*
                  Named explicitly so retiring an employee is never a blind
                  decision — these are the clients who have been talking to them.
                */}
                <p className="mt-1 text-[11px] text-white/35">
                  {p.workspaces.length === 0
                    ? 'Not assigned to any workspace'
                    : `Working: ${p.workspaces.map(w => w.name).join(', ')}`}
                </p>
              </div>

              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => edit(p)}>Edit</Button>
                <Button size="sm" variant="outline" onClick={() => toggle(p)}>
                  {p.enabled ? 'Retire' : 'Restore'}
                </Button>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-white/35">
          Retiring removes an employee from the picker but leaves existing
          assignments alone — a client keeps the agent they know. There is no
          delete, because deleting one would silently revert their workspace to
          a nameless "Agent".
        </p>
      </div>
    </div>
  );
};
