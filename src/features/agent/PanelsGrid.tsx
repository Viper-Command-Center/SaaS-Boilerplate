'use client';

import { useCallback, useEffect, useId, useState } from 'react';

type PanelRow = { row: Record<string, unknown>; capturedAt: string };
type Panel = {
  id: string;
  type: 'kpi' | 'timeseries' | 'table' | 'markdown' | string;
  title: string;
  config: Record<string, unknown>;
  rows: PanelRow[];
};

/**
 * The dashboard the agent builds. Glass cards, gradient-glow charts.
 */
export const PanelsGrid = (props: { tenantSlug: string }) => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    fetch(`/api/panels?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { panels: [] }))
      .then((data) => {
        setPanels(data.panels ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [props.tenantSlug]);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 30_000);
    return () => clearInterval(interval);
  }, [reload]);

  if (!loaded || panels.length === 0) {
    return null;
  }

  return (
    <div className="
      grid gap-4
      sm:grid-cols-2
      lg:grid-cols-3
    "
    >
      {panels.map(panel => (
        <div
          key={panel.id}
          className="
            glass glass-hover glass-topline relative overflow-hidden p-4
          "
        >
          <div className="
            mb-3 flex items-center justify-between text-[10px] font-semibold
            tracking-[0.12em] text-white/40 uppercase
          "
          >
            {panel.title}
            <span className="pulse-dot size-1.5 rounded-full bg-indigo-400" />
          </div>
          <PanelBody panel={panel} />
        </div>
      ))}
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
