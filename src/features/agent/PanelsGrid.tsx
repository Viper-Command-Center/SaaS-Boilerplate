'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

type PanelRow = { row: Record<string, unknown>; capturedAt: string };
type Panel = {
  id: string;
  type: 'kpi' | 'timeseries' | 'table' | 'markdown' | string;
  title: string;
  config: Record<string, unknown>;
  viewId: string | null;
  section: string | null;
  width: number;
  position: number;
  rows: PanelRow[];
};
type View = { id: string; name: string; icon: string | null; position: number };

const UNGROUPED = '__ungrouped__';

/** Tailwind needs static class names — no template-built spans. */
const SPAN: Record<number, string> = {
  1: '',
  2: 'sm:col-span-2',
  3: 'sm:col-span-2 lg:col-span-3',
};

/** Per-user, per-workspace UI preference. Not worth a DB round-trip. */
function usePrefs(tenantSlug: string) {
  const key = `artivio:dash:${tenantSlug}`;
  const read = (): { view?: string; collapsed?: string[] } => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {
      return {};
    }
  };
  const write = (patch: Record<string, unknown>) => {
    try {
      localStorage.setItem(key, JSON.stringify({ ...read(), ...patch }));
    } catch {
      // Private mode / storage full — layout still works, it just won't persist.
    }
  };
  return { read, write };
}

/**
 * The dashboard the agent builds.
 *
 * Layout has three levels so it stays readable as MCPs pile up: tabs (views) →
 * collapsible sections → width-aware cards. Panels are draggable within and
 * between sections and onto tabs; the agent can do all of the same via
 * create_view / move_panels, which is the faster route for a big reorganise.
 */
export const PanelsGrid = (props: { tenantSlug: string; canEdit?: boolean }) => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeView, setActiveView] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const prefs = usePrefs(props.tenantSlug);

  // A poll landing mid-drag would yank the card out from under the cursor, and
  // one landing before PATCH resolves would show the pre-drag order.
  const frozen = useRef(false);

  const reload = useCallback(() => {
    if (frozen.current) {
      return;
    }
    fetch(`/api/panels?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { panels: [], views: [] }))
      .then((data) => {
        if (frozen.current) {
          return;
        }
        setPanels(data.panels ?? []);
        setViews(data.views ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [props.tenantSlug]);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 30_000);
    return () => clearInterval(interval);
  }, [reload]);

  // Restore the tab + collapsed sections this user last chose here.
  useEffect(() => {
    const saved = prefs.read();
    setCollapsed(new Set(saved.collapsed ?? []));
    setActiveView(saved.view ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tenantSlug]);

  const currentView = useMemo(() => {
    if (activeView && views.some(v => v.id === activeView)) {
      return activeView;
    }
    return views[0]?.id ?? null;
  }, [activeView, views]);

  const visible = useMemo(
    () => panels
      .filter(p => p.viewId === currentView)
      .sort((a, b) => a.position - b.position),
    [panels, currentView],
  );

  // Sections in the order their first panel appears — ungrouped always first.
  const sections = useMemo(() => {
    const order: string[] = [];
    for (const p of visible) {
      const key = p.section ?? UNGROUPED;
      if (!order.includes(key)) {
        order.push(key);
      }
    }
    return order.sort((a, b) => (a === UNGROUPED ? -1 : b === UNGROUPED ? 1 : 0));
  }, [visible]);

  const toggleSection = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setCollapsed(next);
    prefs.write({ collapsed: [...next] });
  };

  const pickView = (id: string) => {
    setActiveView(id);
    prefs.write({ view: id });
  };

  /** Apply a move locally, then persist. Optimistic — a drag must feel instant. */
  const persist = async (next: Panel[]) => {
    frozen.current = true;
    setPanels(next);
    const moves = next.map((p, i) => ({
      id: p.id,
      viewId: p.viewId,
      section: p.section,
      position: i,
    }));
    try {
      await fetch(`/api/panels?tenant=${encodeURIComponent(props.tenantSlug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moves }),
      });
    } catch {
      // Swallow: the next poll re-reads the server's truth, which is the
      // honest state. Better a silent revert than a lying dashboard.
    } finally {
      frozen.current = false;
    }
  };

  /** Drop `dragId` immediately before `beforeId` (or at the end of a section). */
  const dropOnPanel = (beforeId: string) => {
    if (!dragId || dragId === beforeId) {
      return;
    }
    const src = panels.find(p => p.id === dragId);
    const dst = panels.find(p => p.id === beforeId);
    if (!src || !dst) {
      return;
    }
    const rest = panels.filter(p => p.id !== dragId);
    const at = rest.findIndex(p => p.id === beforeId);
    const moved = { ...src, viewId: dst.viewId, section: dst.section };
    persist([...rest.slice(0, at), moved, ...rest.slice(at)]);
  };

  const dropOnSection = (sectionKey: string) => {
    if (!dragId) {
      return;
    }
    const src = panels.find(p => p.id === dragId);
    if (!src) {
      return;
    }
    const section = sectionKey === UNGROUPED ? null : sectionKey;
    const rest = panels.filter(p => p.id !== dragId);
    const lastOfSection = rest.map(p => p.viewId === currentView && (p.section ?? UNGROUPED) === sectionKey).lastIndexOf(true);
    const moved = { ...src, viewId: currentView, section };
    const at = lastOfSection === -1 ? rest.length : lastOfSection + 1;
    persist([...rest.slice(0, at), moved, ...rest.slice(at)]);
  };

  const dropOnTab = (viewId: string) => {
    if (!dragId) {
      return;
    }
    const src = panels.find(p => p.id === dragId);
    if (!src || src.viewId === viewId) {
      return;
    }
    const rest = panels.filter(p => p.id !== dragId);
    // Landing on a foreign tab keeps the card but drops the group — its old
    // section label would be meaningless over there.
    persist([...rest, { ...src, viewId, section: null }]);
  };

  const endDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };

  if (!loaded || panels.length === 0) {
    return null;
  }

  const canEdit = props.canEdit ?? false;

  return (
    <div className="space-y-4">
      {/* Tabs — the primitive that keeps this readable at 5 MCPs and 60 panels */}
      {views.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {views.map((v) => {
            const count = panels.filter(p => p.viewId === v.id).length;
            const active = v.id === currentView;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => pickView(v.id)}
                onDragOver={(e) => {
                  if (dragId) {
                    e.preventDefault();
                    setDropTarget(`tab:${v.id}`);
                  }
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnTab(v.id);
                  endDrag();
                }}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  dropTarget === `tab:${v.id}`
                    ? 'border-indigo-400 bg-indigo-400/20 text-white'
                    : active
                      ? 'nav-active border-white/15 text-white'
                      : 'border-white/10 text-white/50 hover:border-white/25 hover:text-white/80'
                }`}
              >
                {v.icon && <span aria-hidden>{v.icon}</span>}
                {v.name}
                <span className="text-[10px] text-white/30">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {sections.map((sectionKey) => {
        const inSection = visible.filter(p => (p.section ?? UNGROUPED) === sectionKey);
        const isCollapsed = collapsed.has(sectionKey);
        const named = sectionKey !== UNGROUPED;

        return (
          <div key={sectionKey} className="space-y-3">
            {named && (
              <button
                type="button"
                onClick={() => toggleSection(sectionKey)}
                onDragOver={(e) => {
                  if (dragId) {
                    e.preventDefault();
                    setDropTarget(`sec:${sectionKey}`);
                  }
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnSection(sectionKey);
                  endDrag();
                }}
                className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                  dropTarget === `sec:${sectionKey}`
                    ? 'border-indigo-400 bg-indigo-400/10'
                    : 'border-transparent hover:bg-white/[0.03]'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`size-3 fill-none stroke-white/40 stroke-2 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className="
                  text-[11px] font-semibold tracking-[0.14em] text-white/45
                  uppercase
                "
                >
                  {sectionKey}
                </span>
                <span className="text-[10px] text-white/25">{inSection.length}</span>
                <span className="ml-2 h-px flex-1 bg-white/8" />
              </button>
            )}

            {!isCollapsed && (
              <div className="
                grid gap-4
                sm:grid-cols-2
                lg:grid-cols-3
              "
              >
                {inSection.map(panel => (
                  <div
                    key={panel.id}
                    draggable={canEdit}
                    onDragStart={() => setDragId(panel.id)}
                    onDragEnd={endDrag}
                    onDragOver={(e) => {
                      if (dragId && dragId !== panel.id) {
                        e.preventDefault();
                        setDropTarget(panel.id);
                      }
                    }}
                    onDragLeave={() => setDropTarget(t => (t === panel.id ? null : t))}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropOnPanel(panel.id);
                      endDrag();
                    }}
                    className={`glass glass-hover glass-topline group relative overflow-hidden p-4 ${SPAN[panel.width] ?? ''} ${
                      dragId === panel.id ? 'opacity-40' : ''
                    } ${dropTarget === panel.id ? 'ring-2 ring-indigo-400' : ''} ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  >
                    <div className="
                      mb-3 flex items-center justify-between text-[10px]
                      font-semibold tracking-[0.12em] text-white/40 uppercase
                    "
                    >
                      <span className="flex items-center gap-1.5">
                        {canEdit && (
                          <svg viewBox="0 0 24 24" className="size-3 fill-white/20 opacity-0 transition group-hover:opacity-100" aria-hidden>
                            <circle cx="9" cy="6" r="1.5" />
                            <circle cx="15" cy="6" r="1.5" />
                            <circle cx="9" cy="12" r="1.5" />
                            <circle cx="15" cy="12" r="1.5" />
                            <circle cx="9" cy="18" r="1.5" />
                            <circle cx="15" cy="18" r="1.5" />
                          </svg>
                        )}
                        {panel.title}
                      </span>
                      <span className="pulse-dot size-1.5 rounded-full bg-indigo-400" />
                    </div>
                    <PanelBody panel={panel} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const PanelBody = ({ panel }: { panel: Panel }) => {
  const gid = useId().replace(/:/g, '');

  if (panel.type === 'markdown') {
    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-white/70">
        {String(panel.config.text ?? '')}
      </p>
    );
  }

  if (panel.type === 'kpi') {
    const field = String(panel.config.valueField ?? 'value');
    const latest = panel.rows[panel.rows.length - 1];
    const value = latest ? latest.row[field] : undefined;
    return (
      <div>
        <div className="grad-text text-4xl font-extrabold tracking-tight">
          {value === undefined ? '—' : String(value)}
        </div>
        {typeof panel.config.label === 'string' && (
          <div className="mt-1 text-xs text-white/45">{panel.config.label}</div>
        )}
      </div>
    );
  }

  if (panel.type === 'timeseries') {
    const field = String(panel.config.valueField ?? 'value');
    const values = panel.rows.map(r => num(r.row[field]));
    if (values.length < 2) {
      return <p className="text-xs text-white/40">Waiting for data…</p>;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 300;
    const h = 80;
    const pts = values.map((v, i) => [
      (i / (values.length - 1)) * w,
      h - ((v - min) / range) * (h - 14) - 7,
    ] as const);
    const line = pts.map(([x, y]) => `${x},${y}`).join(' ');
    const area = `0,${h} ${line} ${w},${h}`;
    const last = pts[pts.length - 1]!;
    const first = values[0]!;
    const latest = values[values.length - 1]!;
    const delta = first === 0 ? 0 : ((latest - first) / Math.abs(first)) * 100;

    return (
      <div>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-white">{latest.toLocaleString()}</span>
          <span className={`text-xs font-medium ${delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {delta >= 0 ? '▲' : '▼'}
            {' '}
            {Math.abs(delta).toFixed(1)}
            %
          </span>
        </div>

        <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" preserveAspectRatio="none" role="img" aria-label={panel.title}>
          <defs>
            <linearGradient id={`s-${gid}`} x1="0" y1="0" x2={w} y2="0" gradientUnits="userSpaceOnUse">
              <stop stopColor="#818cf8" />
              <stop offset="0.6" stopColor="#c084fc" />
              <stop offset="1" stopColor="#f0abfc" />
            </linearGradient>
            <linearGradient id={`f-${gid}`} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
              <stop stopColor="#818cf8" stopOpacity="0.35" />
              <stop offset="1" stopColor="#818cf8" stopOpacity="0" />
            </linearGradient>
            <filter id={`g-${gid}`} x="-20%" y="-40%" width="140%" height="180%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <polygon points={area} fill={`url(#f-${gid})`} />
          <polyline
            points={line}
            fill="none"
            stroke={`url(#s-${gid})`}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#g-${gid})`}
          />
          <circle cx={last[0]} cy={last[1]} r="3.5" fill="#f0abfc" filter={`url(#g-${gid})`} />
        </svg>

        <div className="mt-1 flex justify-between text-[10px] text-white/35">
          <span>{min.toLocaleString()}</span>
          <span>{max.toLocaleString()}</span>
        </div>
      </div>
    );
  }

  // table
  const columns = Array.isArray(panel.config.columns) && panel.config.columns.length > 0
    ? (panel.config.columns as string[])
    : Object.keys(panel.rows[panel.rows.length - 1]?.row ?? {}).slice(0, 4);
  const rows = panel.rows.slice(-8).reverse();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="
            text-left text-[10px] tracking-wider text-white/35 uppercase
          "
          >
            {columns.map(c => <th key={c} className="pr-3 pb-2 font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody className="text-white/75">
          {rows.map((r, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i} className="border-t border-white/6">
              {columns.map(c => (
                <td key={c} className="py-1.5 pr-3">{String(r.row[c] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
