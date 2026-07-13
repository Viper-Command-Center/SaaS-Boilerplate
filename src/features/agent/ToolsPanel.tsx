'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type Connection = {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  toolPolicy: Record<string, string> | null;
  enabled: boolean;
};

type CatalogPlugin = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  tier: string;
  authHint: string | null;
  needsKey: boolean;
  installed: boolean;
  pricing: Array<{ tool: string; unit: string; retailUsd: number }>;
};

/**
 * Per-tenant MCP tool registry panel: list connections, toggle them, add new
 * servers. Credential values go straight to the encrypted vault server-side
 * and are never echoed back.
 */
export const ToolsPanel = (props: { tenantSlug: string }) => {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [vaultOk, setVaultOk] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');

  const reload = useCallback(() => {
    fetch(`/api/mcp/connections?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { connections: [] }))
      .then((data) => {
        setConnections(data.connections ?? []);
        setVaultOk(data.vaultConfigured !== false);
      })
      .catch(() => {});
    fetch(`/api/plugins?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { plugins: [] }))
      .then(data => setCatalog(data.plugins ?? []))
      .catch(() => {});
  }, [props.tenantSlug]);

  const enablePlugin = async (plugin: CatalogPlugin) => {
    if (plugin.needsKey && !keyValue.trim()) {
      setKeyFor(plugin.id);
      return;
    }
    setError(null);
    const res = await fetch('/api/plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug: props.tenantSlug,
        pluginId: plugin.id,
        credentialValue: plugin.needsKey ? keyValue.trim() : undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not enable.');
      return;
    }
    setKeyFor(null);
    setKeyValue('');
    reload();
  };

  useEffect(() => {
    reload();
  }, [reload]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/mcp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: props.tenantSlug,
          name: name.trim().toLowerCase(),
          url: url.trim(),
          ...(headerValue.trim()
            ? { headers: { [headerName.trim() || 'Authorization']: headerValue.trim() } }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? 'Could not add the server.');
      } else {
        setName('');
        setUrl('');
        setHeaderValue('');
        setShowForm(false);
        reload();
      }
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (conn: Connection) => {
    await fetch(`/api/mcp/connections/${conn.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !conn.enabled }),
    }).catch(() => {});
    reload();
  };

  const remove = async (conn: Connection) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove tool server "${conn.name}" and its stored credentials?`)) {
      return;
    }
    await fetch(`/api/mcp/connections/${conn.id}`, { method: 'DELETE' }).catch(() => {});
    reload();
  };

  const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="glass glass-topline relative">
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div>
          <span className="text-sm font-semibold">Tools (MCP servers)</span>
          <p className="text-xs text-muted-foreground">
            Connect tool servers to give the agent real capabilities. New tools
            require approval by default.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowForm(s => !s)}>
          {showForm ? 'Cancel' : 'Add MCP server'}
        </Button>
      </div>

      {!vaultOk && (
        <p className="border-b px-4 py-2 text-xs text-red-600">
          Credential vault not configured — set VAULT_MASTER_KEY in Railway
          before adding servers that need credentials.
        </p>
      )}

      {showForm && (
        <form onSubmit={add} className="space-y-3 border-b p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="mcp-name">Name (a-z, 0-9, dashes)</label>
              <input id="mcp-name" className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="dataforseo" required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="mcp-url">MCP server URL</label>
              <input id="mcp-url" className={inputClass} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/mcp" required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="mcp-header">Auth header (optional)</label>
              <input id="mcp-header" className={inputClass} value={headerName} onChange={e => setHeaderName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="mcp-secret">Header value (stored encrypted)</label>
              <input id="mcp-secret" type="password" className={inputClass} value={headerValue} onChange={e => setHeaderValue(e.target.value)} placeholder="Bearer sk_…" />
            </div>
          </div>
          {error && <p classNa