'use client';

import { useEffect, useState } from 'react';
import { AgentAvatar } from '@/features/agent/AgentAvatar';

type Persona = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  role: string | null;
  avatarUrl: string | null;
  accent: string | null;
};

type State = {
  personas: Persona[];
  current: { name: string; avatarUrl: string | null; accent: string; personaId: string | null };
  canManage: boolean;
};

/**
 * Pick the AI employee who works this workspace. Voice only — every employee
 * has exactly the same tools, approvals and spend limits.
 */
export const EmployeePanel = (props: { tenantSlug: string }) => {
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [rename, setRename] = useState('');
  const [open, setOpen] = useState(false);

  const load = () => {
    fetch(`/api/personas?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: State | null) => {
        setState(d);
        setRename(d?.current.name && d.current.name !== 'Agent' ? d.current.name : '');
      })
      .catch(() => setState(null));
  };

  useEffect(load, [props.tenantSlug]);

  const assign = async (personaId: string | null, agentName?: string | null) => {
    setSaving(personaId ?? 'none');
    setError('');
    try {
      const res = await fetch('/api/personas', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantSlug: props.tenantSlug, personaId, agentName }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed (${res.status})`);
      }
      // The name/avatar live in a server-rendered header — reload to pick them up.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setSaving(null);
    }
  };

  if (!state || !state.canManage) {
    return null;
  }

  return (
    <div className="glass glass-topline p-4">
      <div className="flex items-center gap-2">
        <AgentAvatar
          name={state.current.name}
          avatarUrl={state.current.avatarUrl}
          accent={state.current.accent}
          size={26}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{state.current.name}</p>
          <p className="text-[11px] text-white/40">Your AI employee</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="
            rounded-lg border border-white/12 px-2.5 py-1 text-[11px]
            text-white/60 transition
            hover:border-indigo-400/40 hover:text-white
          "
        >
          {open ? 'Close' : 'Change'}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-2">
          {error && <p className="text-xs text-rose-300">{error}</p>}

          {state.personas.map((p) => {
            const active = state.current.personaId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={saving !== null}
                onClick={() => assign(p.id, null)}
                className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition disabled:opacity-40 ${
                  active
                    ? 'border-indigo-400/50 bg-indigo-400/10'
                    : 'border-white/10 hover:border-white/25 hover:bg-white/5'
                }`}
              >
                <AgentAvatar name={p.name} avatarUrl={p.avatarUrl} accent={p.accent} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white">{p.name}</span>
                  <span className="block truncate text-[11px] text-white/40">
                    {p.tagline ?? p.role ?? ''}
                  </span>
                </span>
                {active && <span className="text-[10px] font-semibold text-indigo-300">ACTIVE</span>}
              </button>
            );
          })}

          <button
            type="button"
            disabled={saving !== null}
            onClick={() => assign(null, null)}
            className="
              w-full rounded-xl border border-white/10 px-3 py-2 text-left
              text-xs text-white/45 transition
              hover:border-white/25 hover:text-white/70
              disabled:opacity-40
            "
          >
            No persona — the generic Artivio agent
          </button>

          {state.current.personaId && (
            <div className="flex gap-2 pt-1">
              <input
                value={rename}
                onChange={e => setRename(e.target.value)}
                maxLength={60}
                placeholder="Rename (optional)"
                className="
                  flex-1 rounded-lg border border-white/10 bg-white/[0.04]
                  px-2.5 py-1.5 text-xs text-white/90 outline-none
                  placeholder:text-white/25
                  focus:border-indigo-400/40
                "
              />
              <button
                type="button"
                disabled={saving !== null}
                onClick={() => assign(state.current.personaId, rename.trim() || null)}
                className="
                  rounded-lg border border-white/12 px-2.5 py-1.5 text-[11px]
                  text-white/60 transition
                  hover:border-indigo-400/40 hover:text-white
                "
              >
                Save
              </button>
            </div>
          )}

          <p className="pt-1 text-[11px] leading-relaxed text-white/30">
            Personality changes how your employee sounds, never what it can do —
            approvals, spend limits and workspace boundaries are identical for
            every one.
          </p>
        </div>
      )}
    </div>
  );
};
