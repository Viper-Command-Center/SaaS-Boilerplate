'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type MissionStep = {
  id: string;
  position: number;
  title: string;
  status: string;
  result: string | null;
  attempts: number;
  updatedAt: string;
};

type Mission = {
  id: string;
  title: string;
  goal: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  steps: MissionStep[];
};

/**
 * Missions panel (Phase 29) — the human's live window into durable background
 * work. The agent starts missions via start_mission; the cron runner advances
 * them one step per tick. Before this panel the ONLY way to see mission
 * progress was to ask the agent in chat, and a silently-dead cron (disabled
 * GitHub Action, expired secret) looked identical to a mission that was simply
 * slow — so this surfaces BOTH: per-mission progress AND runner health from
 * the lastTickAt heartbeat.
 *
 * Poll every 20s (missions move on a minutes cadence, not seconds). The panel
 * hides itself entirely when there are no missions AND the runner is healthy —
 * an empty workspace shouldn't grow a permanent empty card.
 */

const POLL_MS = 20_000;
// Matches the ~10-minute cron cadence with headroom: past this with no tick,
// the runner is probably not the mission's fault — point the human at Actions.
const STALE_TICK_MS = 25 * 60_000;

function agoLabel(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

const statusStyles: Record<string, string> = {
  running: 'text-green-600',
  paused: 'text-amber-600',
  waiting_approval: 'text-amber-600',
  done: 'text-muted-foreground',
};

export const MissionsPanel = (props: { tenantSlug: string; canControl: boolean }) => {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch(`/api/missions?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { missions: [], lastTickAt: null }))
      .then((data) => {
        setMissions(data.missions ?? []);
        setLastTickAt(data.lastTickAt ?? null);
        setLoaded(true);
      })
      .catch(() => {});
  }, [props.tenantSlug]);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, POLL_MS);
    return () => clearInterval(interval);
  }, [reload]);

  const control = async (id: string, action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !window.confirm('Cancel this mission? Remaining steps are skipped and it will not run again. There is no undo.')) {
      return;
    }
    setBusyId(id);
    await fetch(`/api/missions?tenant=${encodeURIComponent(props.tenantSlug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    }).catch(() => {});
    setBusyId(null);
    reload();
  };

  // Runner health from the heartbeat. null = the container hasn't seen a tick
  // since its last deploy (in-memory value); old = the cron has gone quiet.
  const tickAgeMs = lastTickAt === null ? null : Date.now() - lastTickAt;
  const health: { tone: string; label: string }
    = lastTickAt === null
      ? { tone: 'text-white/40', label: 'no tick since last deploy' }
      : tickAgeMs !== null && tickAgeMs > STALE_TICK_MS
        ? { tone: 'text-amber-600', label: `no tick in ${Math.floor((tickAgeMs) / 60_000)}m — check GitHub Actions` }
        : { tone: 'text-green-600', label: `runner ticked ${Math.max(1, Math.floor((tickAgeMs ?? 0) / 60_000))}m ago` };

  const active = missions.filter(m => m.status !== 'done');
  const healthy = lastTickAt !== null && tickAgeMs !== null && tickAgeMs <= STALE_TICK_MS;

  // Hide the panel entirely when there's nothing to show and nothing is wrong.
  if (!loaded || (missions.length === 0 && healthy)) {
    return null;
  }

  return (
    <div className="glass glass-topline relative">
      <div className="border-b border-white/8 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">
            Missions
            {active.length > 0 ? ` (${active.length} active)` : ''}
          </span>
          <span className={`text-xs font-medium ${health.tone}`}>{health.label}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Durable background work the agent runs one step at a time.
        </p>
      </div>

      <div className="divide-y">
        {missions.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No missions yet. When you ask the agent for a large, multi-step job
            it starts a mission here.
          </p>
        )}

        {missions.map((m) => {
          const total = m.steps.length;
          const complete = m.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
          const pct = total > 0 ? Math.round((complete / total) * 100) : 0;
          const runningStep = m.steps.find(s => s.status === 'running');
          const canPause = m.status === 'running' || m.status === 'waiting_approval';
          const canResume = m.status === 'paused';
          const canCancel = m.status !== 'done';

          return (
            <div key={m.id} className="space-y-2 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{m.title}</span>
                <span className={`text-xs font-medium ${statusStyles[m.status] ?? ''}`}>{m.status}</span>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-green-500/70 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{complete}/{total} steps</span>
                <span>updated {agoLabel(m.updatedAt)}</span>
              </div>

              {runningStep && (
                <p className="truncate text-xs text-white/60">
                  Running: {runningStep.title}
                </p>
              )}

              {props.canControl && (
                <div className="flex gap-2">
                  {canPause && (
                    <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => control(m.id, 'pause')}>
                      Pause
                    </Button>
                  )}
                  {canResume && (
                    <Button size="sm" disabled={busyId === m.id} onClick={() => control(m.id, 'resume')}>
                      Resume
                    </Button>
                  )}
                  {canCancel && (
                    <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => control(m.id, 'cancel')}>
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
