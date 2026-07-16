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
  /** Header name only — the sealed value never leaves the server. */
  authHeader: string | null;
  hasSecret: boolean;
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
  /** Per-site plugins (WordPress) also need the workspace's own site URL. */
  needsSiteUrl?: boolean;
  installed: boolean;
  pricing: Array<{ tool: string; unit: string; retailUsd: number }>;
};

/**
 * Tools = the workspace's capabilities.
 *  · "Available plugins" — the platform catalog (tier 1 uses our key and is
 *    billed per use; tier 2 asks the client for their own key).
 *  · "Connected" — everything currently wired up, with enable/disable.
 *  · Advanced: point the agent at any hosted MCP server by URL.
 */
export const ToolsPanel = (props: { tenantSlug: string }) => {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [vaultOk, setVaultOk] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // When set, the form is EDITING this connection rather than creating one.
  // Without this, a typo'd URL or a key pasted without its `Bearer ` prefix was
  // unfixable — Remove-and-recreate was the only path, and it silently dropped
  // the connection's tool policies with it.
  const [editing, setEditing] = useState<Connection | null>(null);

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

  useEffect(() => {
    reload();
  }, [reload]);

  const enablePlugin = async (plugin: CatalogPlugin) => {
    // Open the inline form first if we still need something from the client.
    const missing = (plugin.needsKey && !keyValue.trim())
      || (plugin.needsSiteUrl && !siteUrl.trim());
    if (missing) {
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
        siteUrl: plugin.needsSiteUrl ? siteUrl.trim() : undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not enable.');
      return;
    }
    setKeyFor(null);
    setKeyValue('');
    setSiteUrl('');
    reload();
  };

  /**
   * Probe the server BEFORE saving. Most "the agent says the tool is broken"
   * reports are a wrong URL or a bad key — this surfaces that next to the field
   * that caused it, instead of mid-conversation three days later.
   */
  const test = async () => {
    setTestResult(null);
    setError(null);
    setTesting(true);
    try {
      const res = await fetch('/api/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: props.tenantSlug,
          url: url.trim(),
          ...(headerValue.trim()
            ? { headerName: headerName.trim() || 'Authorization', headerValue: headerValue.trim() }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      setTestResult(data?.ok
        ? { ok: true, message: data.message ?? 'Connected.' }
        : { ok: false, message: data?.guidance ?? data?.error ?? 'Could not reach the server.' });
    } catch {
      setTestResult({ ok: false, message: 'Network error while testing.' });
    } finally {
      setTesting(false);
    }
  };

  const resetForm = () => {
    setName('');
    setUrl('');
    setHeaderName('Authorization');
    setHeaderValue('');
    setEditing(null);
    setShowForm(false);
    setTestResult(null);
    setError(null);
  };

  /** Load a connection into the form. The secret is never read back, so the
   *  value field starts blank and blank means "keep the existing key". */
  const startEdit = (conn: Connection) => {
    setEditing(conn);
    setName(conn.name);
    setUrl(conn.url ?? '');
    setHeaderName(conn.authHeader ?? 'Authorization');
    setHeaderValue('');
    setTestResult(null);
    setError(null);
    setShowForm(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = editing
        ? await fetch(`/api/mcp/connections/${editing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name.trim().toLowerCase(),
              url: url.trim(),
              authHeader: headerName.trim() || 'Authorization',
              // Blank = keep the stored secret.
              ...(headerValue.trim() ? { authValue: headerValue.trim() } : {}),
            }),
          })
        : await fetch('/api/mcp/connections', {
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
        setError(data?.error ?? (editing ? 'Could not save the changes.' : 'Could not add the server.'));
      } else {
        resetForm();
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
    if (!window.confirm(`Remove "${conn.name}" and its stored credentials?`)) {
      return;
    }
    await fetch(`/api/mcp/connections/${conn.id}`, { method: 'DELETE' }).catch(() => {});
    reload();
  };

  const inputClass = 'w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm text-white/90 outline-none transition placeholder:text-white/30 focus:border-indigo-400/40';
  const available = catalog.filter(p => !p.installed);

  return (
    <div className="glass glass-topline relative">
      <div className="
        flex items-center justify-between border-b border-white/8 px-4 py-3
      "
      >
        <div>
          <span className="text-sm font-semibold text-white">Tools</span>
          <p className="text-xs text-white/40">
            Capabilities the agent can use. New tools need approval by default.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (showForm ? resetForm() : setShowForm(true))}
        >
          {showForm ? 'Cancel' : 'Add MCP server'}
        </Button>
      </div>

      {!vaultOk && (
        <p className="
          border-b border-white/8 px-4 py-2 text-xs text-rose-300
        "
        >
          Credential vault not configured — set VAULT_MASTER_KEY in Railway
          before adding tools that need credentials.
        </p>
      )}

      {error && (
        <p className="border-b border-white/8 px-4 py-2 text-xs text-rose-300" role="alert">
          {error}
        </p>
      )}

      {/* Advanced: any hosted MCP server. Doubles as the EDIT form. */}
      {showForm && (
        <form onSubmit={save} className="space-y-3 border-b border-white/8 p-4">
          {editing && (
            <p className="text-xs text-white/45">
              Editing
              {' '}
              <span className="text-white/80">{editing.name}</span>
              . Leave the key blank to keep the current one.
            </p>
          )}
          <div className="
            grid gap-3
            sm:grid-cols-2
          "
          >
            <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. github)" required />
            <input className={inputClass} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/mcp" required />
            <input className={inputClass} value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="Auth header" />
            <input
              className={inputClass}
              type="password"
              value={headerValue}
              onChange={e => setHeaderValue(e.target.value)}
              placeholder={editing?.hasSecret ? 'Leave blank to keep current key' : 'Bearer sk_… (encrypted)'}
            />
          </div>
          {/* Most 401s are a key pasted without its prefix. Say so where it
              happens rather than letting the agent guess about it later. */}
          <p className="text-[11px] text-white/30">
            Include the prefix the vendor expects — usually
            {' '}
            <code className="text-white/50">Bearer sk_…</code>
            . A few (Duda) want the raw token with no prefix.
          </p>
          {testResult && (
            <p className={`text-xs ${testResult.ok ? 'text-emerald-300' : 'text-rose-300'}`} role="status">
              {testResult.ok ? '✓ ' : '✗ '}
              {testResult.message}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add server'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={testing || !url.trim()}
              onClick={test}
              title={editing && !headerValue.trim() ? 'Enter the key to test — the stored one can’t be read back' : undefined}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="outline" onClick={resetForm}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {/* Marketplace */}
      {available.length > 0 && (
        <div className="border-b border-white/8">
          <p className="
            px-4 pt-3 pb-1 text-[10px] font-semibold tracking-[0.12em]
            text-white/35 uppercase
          "
          >
            Available plugins
          </p>
          <div className="divide-y divide-white/6">
            {available.map(p => (
              <div key={p.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-white">{p.name}</span>
                      {p.tier === 'tier1'
                        ? (
                            <span className="
                              rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px]
                              text-indigo-300
                            "
                            >
                              included · pay per use
                            </span>
                          )
                        : (
                            <span className="
                              rounded bg-white/10 px-1.5 py-0.5 text-[10px]
                              text-white/50
                            "
                            >
                              needs your key
                            </span>
                          )}
                    </div>
                    {p.description && <p className="mt-0.5 text-xs text-white/45">{p.description}</p>}
                    {p.pricing.length > 0 && (
                      <p className="mt-1 text-xs text-white/35">
                        {p.pricing.map(pr => `${pr.tool}: $${pr.retailUsd}/${pr.unit}`).join(' · ')}
                      </p>
                    )}
                  </div>
                  <Button size="sm" onClick={() => enablePlugin(p)}>Enable</Button>
                </div>

                {keyFor === p.id && (
                  <div className="mt-2 space-y-2">
                    {p.needsSiteUrl && (
                      <input
                        className={inputClass}
                        placeholder="Your site URL — https://yoursite.com"
                        value={siteUrl}
                        onChange={e => setSiteUrl(e.target.value)}
                      />
                    )}
                    <div className="flex gap-2">
                      <input
                        type="password"
                        className={inputClass}
                        placeholder={p.authHint ?? 'Your API key'}
                        value={keyValue}
                        onChange={e => setKeyValue(e.target.value)}
                      />
                      <Button size="sm" onClick={() => enablePlugin(p)}>Save</Button>
                    </div>
                    {p.authHint && (
                      <p className="text-xs text-white/35">{p.authHint}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connected */}
      <div className="divide-y divide-white/6">
        {connections.length === 0 && (
          <p className="px-4 py-4 text-sm text-white/40">
            No tools enabled yet. Enable a plugin above, or connect any hosted MCP server.
          </p>
        )}
        {connections.map(conn => (
          <div key={conn.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full ${conn.enabled ? 'bg-emerald-400' : 'bg-white/25'}`} />
                <span className="text-sm font-medium text-white">{conn.name}</span>
              </div>
              <p className="truncate pl-3.5 text-xs text-white/35">
                {conn.transport === 'builtin' ? 'built-in plugin' : conn.url}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* Built-ins have no URL or header to edit — their credential is
                  managed in the admin catalog, not here. */}
              {conn.transport !== 'builtin' && (
                <Button variant="outline" size="sm" onClick={() => startEdit(conn)}>Edit</Button>
              )}
              <Button variant="outline" size="sm" onClick={() => toggle(conn)}>
                {conn.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => remove(conn)}>Remove</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
