'use client';

import { useCallback, useEffect, useState } from 'react';

type PanelRow = { row: Record<string, unknown>; capturedAt: string };
type Panel = {
  id: string;
  type: 'kpi' | 'timeseries' | 'table' | 'markdown' | string;
  title: string;
  config: Record<string, unknown>;
  rows: PanelRow[];
};

/**
 * Dynamic dashboard grid — renders whatever panels the agent has configured.
 * Ask the agent things like "add a KPI panel for organic traffic" and this
 * grid updates on the next refresh cycle (30s poll).
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
    return null; // dashboard stays clean until the agent creates panels
  }

  return (
    <div className="
      grid gap-4 sm:grid-cols-2
      lg:grid-cols-3
    "
    >
      {panels.map(panel => (
        <div key={panel.id} className="rounded-lg border bg-background p-4">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">{panel.title}</div>
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
  if (panel.type === 'markdown') {
    return (
      <p className="text-sm whitespace-pre-wrap">{String(panel.config.text ?? '')}</p>
    );
  }

  if (panel.type === 'kpi') {
    const field = String(panel.config.valueField ?? 'value');
    const latest = panel.rows[panel.rows.length - 1];
    const value = latest ? latest.row[field] : undefined;
    return (
      <div>
        <div className="text-3xl font-bold">{value === undefined ? '—' : String(value)}</div>
        {typeof panel.config.label === 'string' && (
          <div className="text-xs text-muted-foreground">{panel.config.label}</div>
        )}
      </div>
    );
  }

  if (panel.type === 'timeseries') {
    const field = String(panel.config.valueField ?? 'value');
    const values = panel.rows.map(r => num(r.row[field]));
    if (values.length < 2) {
      return <p className="text-xs text-muted-foreground">Waiting for data…</p>;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 280;
    const h = 64;
    const points = values
      .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * (h - 8) - 4}`)
      .join(' ');
    return (
      <div>
        <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label={panel.title}>
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" />
        </svg>
        <div className="
          flex justify-between text-xs text-muted-foreground
        "
        >
          <span>{min}</span>
          <span>
            latest:
            {' '}
            {values[values.length - 1]}
          </span>
          <span>{max}</span>
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
          <tr className="text-left text-muted-foreground">
            {columns.map(c => <th key={c} className="pr-3 pb-1 font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i} className="border-t">
              {columns.map(c => (
                <td key={c} className="py-1 pr-3">{String(r.row[c] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
