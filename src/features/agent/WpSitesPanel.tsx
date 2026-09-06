'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * WordPress Sites (Phase 34) — the sub-panel under the `wp-sites` connection
 * row in the Tools panel. One workspace, N sites, each with:
 *   · label + URL
 *   · username + application password (or, under Advanced, a custom token)
 *   · optional WP-CLI over SSH: host/port/user/path + a workspace SSH key
 *   · per-channel policy: REST / MCP / CLI → Auto-run / Ask first / Blocked
 *   · Test → channel-by-channel report with remediation hints
 *   · Rotate → new application password, verified, old one revoked
 *   · Activity → the per-site audit trail
 * No auth-prefix words, no header names, no MCP endpoint field: those are the
 * platform's job (§3, §4) — the acceptance test greps this file for them. The API shapes mirror src/libs/wpsites/types.ts.
 */

type Channel = 'rest' | 'mcp' | 'cli';
type PolicyValue = 'auto' | 'ask' | 'blocked';
type TestRow = { check: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string; hint?: string };
type TestReport = { status: string; rows: TestRow[]; durationMs: number; testedAt: string };
type SshKey = { id: string; label: string; publicKey: string; fingerprint: string };
type Site = {
  id: string;
  label: string;
  isDefault: boolean;
  siteUrl: string;
  authScheme: 'basic' | 'bearer';
  authUser: string | null;
  secretMask: string;
  ssh: { host: string; port: number; user: string; path: string; keyId: string | null } | null;
  mcpEndpointUrl: string | null;
  wpVersion: string | null;
  phpVersion: string | null;
  builder: string | null;
  builderVersion: string | null;
  agentConnectorVersion: string | null;
  capabilities: { rest: boolean; mcp: boolean; cli: boolean; mcp_tools: string[]; builder_abilities: string[]; base_plugin: boolean };
  policy: Record<Channel, PolicyValue>;
  status: 'healthy' | 'degraded' | 'failed' | 'untested';
  lastTestAt: string | null;
  lastTestReport: TestReport | null;
};
type LegacyConn = { id: string; name: string; provider: 'wordpress' | 'wpcli'; target: string; enabled: boolean };
type Activity = { at: string; actor: string; action: string; detail: Record<string, unknown> };

type FormState = {
  id: string | null;
  label: string;
  siteUrl: string;
  authScheme: 'basic' | 'bearer';
  authUser: string;
  authSecret: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  wpPath: string;
  sshKeyId: string;
  policy: Record<Channel, PolicyValue>;
  isDefault: boolean;
};

const EMPTY_FORM: FormState = {
  id: null,
  label: '',
  siteUrl: '',
  authScheme: 'basic',
  authUser: '',
  authSecret: '',
  sshEnabled: false,
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  wpPath: '',
  sshKeyId: '',
  policy: { rest: 'ask', mcp: 'ask', cli: 'ask' },
  isDefault: false,
};

const inputClass = 'w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm text-white/90 outline-none transition placeholder:text-white/30 focus:border-indigo-400/40';
const selectClass = `${inputClass} appearance-none`;

const STATUS_DOT: Record<Site['status'], string> = {
  healthy: 'bg-emerald-400',
  degraded: 'bg-amber-400',
  failed: 'bg-rose-400',
  untested: 'bg-white/25',
};

function icon(s: TestRow['status']) {
  return s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : s === 'fail' ? '❌' : '⏭️';
}

const ReportView = ({ report }: { report: TestReport }) => (
  <table className="mt-1 w-full text-[11px]">
    <tbody>
      {report.rows.map(r => (
        <tr key={r.check} className="align-top">
          <td className="w-4 pr-1">{icon(r.status)}</td>
          <td className="w-28 pr-2 whitespace-nowrap text-white/60">{r.check}</td>
          <td className="text-white/45">
            {r.detail}
            {r.hint && r.status !== 'ok' && (
              <span className="block text-amber-200/70">
                →
                {r.hint}
              </span>
            )}
          </td>
        </tr>
      ))}
      <tr>
        <td />
        <td colSpan={2} className="pt-1 text-white/30">
          {report.status.toUpperCase()}
          {' · '}
          {report.durationMs}
          ms
        </td>
      </tr>
    </tbody>
  </table>
);

export const WpSitesPanel = (props: { tenantSlug: string }) => {
  const [sites, setSites] = useState<Site[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [legacy, setLegacy] = useState<LegacyConn[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, TestReport>>({});
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, Activity[]>>({});
  const [openActivity, setOpenActivity] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState('');
  const [showProvisioning, setShowProvisioning] = useState(false);

  const reload = useCallback(() => {
    fetch(`/api/wp-sites?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          return;
        }
        setSites(data.sites ?? []);
        setSshKeys(data.sshKeys ?? []);
        setLegacy((data.legacy ?? []).filter((l: LegacyConn) => l.enabled));
        setCanManage(Boolean(data.canManage));
      })
      .catch(() => {});
  }, [props.tenantSlug]);

  useEffect(() => {
    reload();
  }, [reload]);

  const post = async (url: string, body: unknown, method = 'POST') => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error ?? 'Request failed.');
    }
    return data;
  };

  const startAdd = () => {
    setForm({ ...EMPTY_FORM, sshKeyId: sshKeys[0]?.id ?? '', isDefault: sites.length === 0 });
    setAdvanced(false);
    setError(null);
    setNotice(null);
  };

  const startEdit = (s: Site) => {
    setForm({
      id: s.id,
      label: s.label,
      siteUrl: s.siteUrl,
      authScheme: s.authScheme,
      authUser: s.authUser ?? '',
      authSecret: '',
      sshEnabled: Boolean(s.ssh),
      sshHost: s.ssh?.host ?? '',
      sshPort: String(s.ssh?.port ?? 22),
      sshUser: s.ssh?.user ?? '',
      wpPath: s.ssh?.path ?? '',
      sshKeyId: s.ssh?.keyId ?? sshKeys[0]?.id ?? '',
      policy: s.policy,
      isDefault: s.isDefault,
    });
    setAdvanced(s.authScheme === 'bearer');
    setError(null);
    setNotice(null);
  };

  const payloadFromForm = (f: FormState) => ({
    tenantSlug: props.tenantSlug,
    label: f.label.trim(),
    siteUrl: f.siteUrl.trim(),
    authScheme: f.authScheme,
    authUser: f.authScheme === 'basic' ? f.authUser.trim() : null,
    ...(f.authSecret.trim() ? { authSecret: f.authSecret.trim() } : {}),
    isDefault: f.isDefault,
    ssh: f.sshEnabled
      ? { host: f.sshHost.trim(), port: Number(f.sshPort) || 22, user: f.sshUser.trim(), path: f.wpPath.trim(), keyId: f.sshKeyId || null }
      : null,
    policy: f.policy,
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) {
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const data = form.id
        ? await post(`/api/wp-sites/${form.id}`, payloadFromForm(form), 'PATCH')
        : await post('/api/wp-sites', payloadFromForm(form));
      if (data?.report && data?.site?.id) {
        setReports(prev => ({ ...prev, [data.site.id]: data.report }));
        setOpenReport(data.site.id);
      }
      setForm(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: string, writeProbe = false) => {
    setBusy(`test:${id}`);
    setError(null);
    try {
      const data = await post(`/api/wp-sites/${id}/test`, { tenantSlug: props.tenantSlug, writeProbe });
      setReports(prev => ({ ...prev, [id]: data.report }));
      setOpenReport(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setBusy(null);
    }
  };

  /** Test from inside the form: save first (a test needs stored credentials), then run. */
  const testFromForm = async () => {
    if (!form) {
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const data = form.id
        ? await post(`/api/wp-sites/${form.id}`, { ...payloadFromForm(form), skipTest: true }, 'PATCH')
        : await post('/api/wp-sites', { ...payloadFromForm(form), skipTest: true });
      const id: string = data.site.id;
      setForm(f => (f ? { ...f, id, authSecret: '' } : f));

      await test(id);

      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test.');
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (s: Site) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Rotate the application password for "${s.label}"? A new one is created and verified before the old one is revoked — no downtime.`)) {
      return;
    }
    setBusy(`rotate:${s.id}`);
    setError(null);
    try {
      const data = await post(`/api/wp-sites/${s.id}/rotate`, { tenantSlug: props.tenantSlug });
      setNotice(`Rotated "${s.label}": new password "${data.name}"${data.revokedOld ? ', old one revoked.' : '.'}${data.note ? ` ${data.note}` : ''}`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rotation failed.');
    } finally {
      setBusy(null);
    }
  };

  const setPolicy = async (s: Site, channel: Channel, value: PolicyValue) => {
    try {
      await post(`/api/wp-sites/${s.id}`, { tenantSlug: props.tenantSlug, policy: { [channel]: value } }, 'PATCH');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update policy.');
    }
  };

  const makeDefault = async (s: Site) => {
    try {
      await post(`/api/wp-sites/${s.id}`, { tenantSlug: props.tenantSlug, setDefault: true }, 'PATCH');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set default.');
    }
  };

  const remove = async (s: Site) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove "${s.label}" and its stored credentials? The site itself is untouched.`)) {
      return;
    }
    await fetch(`/api/wp-sites/${s.id}?tenant=${encodeURIComponent(props.tenantSlug)}`, { method: 'DELETE' }).catch(() => {});
    reload();
  };

  const generateKey = async () => {
    setBusy('key');
    setError(null);
    try {
      const label = sshKeys.length === 0 ? 'workspace-default' : `key-${sshKeys.length + 1}`;
      const data = await post('/api/wp-sites/ssh-keys', { tenantSlug: props.tenantSlug, label });
      setShownKey(data.key.id);
      setForm(f => (f ? { ...f, sshKeyId: data.key.id } : f));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a key.');
    } finally {
      setBusy(null);
    }
  };

  const importLegacy = async () => {
    setBusy('legacy');
    setError(null);
    try {
      const data = await post('/api/wp-sites/import', { tenantSlug: props.tenantSlug, legacy: true });
      const s = data.summary;
      setNotice(`Imported ${s.created.length} site(s)${s.attachedCli.length ? `, attached WP-CLI to ${s.attachedCli.join(', ')}` : ''}; ${s.disabled} legacy connection(s) disabled.${s.skipped.length ? ` Skipped: ${s.skipped.join(' · ')}` : ''}`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(null);
    }
  };

  const importProvisioning = async () => {
    setBusy('prov');
    setError(null);
    try {
      const data = await post('/api/wp-sites/import', { tenantSlug: props.tenantSlug, provisioning: provisioning.trim() });
      if (data?.report && data?.site?.id) {
        setReports(prev => ({ ...prev, [data.site.id]: data.report }));
        setOpenReport(data.site.id);
      }
      setProvisioning('');
      setShowProvisioning(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the site.');
    } finally {
      setBusy(null);
    }
  };

  const loadActivity = async (s: Site) => {
    if (openActivity === s.id) {
      setOpenActivity(null);
      return;
    }
    const res = await fetch(`/api/wp-sites/${s.id}/activity?tenant=${encodeURIComponent(props.tenantSlug)}`);
    const data = await res.json().catch(() => null);
    setActivity(prev => ({ ...prev, [s.id]: data?.activity ?? [] }));
    setOpenActivity(s.id);
  };

  const policyButton = (s: Site, channel: Channel) => (
    <div key={channel} className="flex items-center gap-1">
      <span className="w-8 text-[10px] tracking-wide text-white/40 uppercase">{channel}</span>
      <select
        className="
          rounded-full border border-white/15 bg-white/4 px-2 py-0.5 text-[10px]
          text-white/70
        "
        value={s.policy[channel]}
        disabled={!canManage}
        onChange={e => setPolicy(s, channel, e.target.value as PolicyValue)}
        title={channel === 'rest' ? 'REST API writes' : channel === 'mcp' ? 'MCP abilities (builder edits)' : 'WP-CLI over SSH'}
      >
        <option value="auto">Auto-run</option>
        <option value="ask">Ask first</option>
        <option value="blocked">Blocked</option>
      </select>
    </div>
  );

  const selectedKey = form ? sshKeys.find(k => k.id === form.sshKeyId) : undefined;

  return (
    <div className="mt-2 ml-3.5 rounded-lg border border-white/8 bg-white/2">
      <div className="
        flex flex-wrap items-center justify-between gap-2 border-b
        border-white/8 px-3 py-2
      "
      >
        <div>
          <span className="text-xs font-semibold text-white/80">Sites</span>
          <span className="ml-2 text-[11px] text-white/35">
            {sites.length === 0 ? 'none yet' : `${sites.length} · the agent addresses them by label`}
          </span>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowProvisioning(v => !v)}>
              {showProvisioning ? 'Cancel' : 'Add from provisioning token'}
            </Button>
            <Button size="sm" onClick={form && !form.id ? () => setForm(null) : startAdd}>
              {form && !form.id ? 'Cancel' : 'Add site'}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p
          className="border-b border-white/8 px-3 py-2 text-xs text-rose-300"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          className="border-b border-white/8 px-3 py-2 text-xs text-emerald-300"
          role="status"
        >
          {notice}
        </p>
      )}

      {legacy.length > 0 && canManage && (
        <div className="
          flex flex-wrap items-center justify-between gap-2 border-b
          border-white/8 bg-amber-400/5 px-3 py-2
        "
        >
          <p className="text-xs text-amber-200/80">
            {legacy.length}
            {' '}
            legacy connection
            {legacy.length === 1 ? '' : 's'}
            {' '}
            (
            {legacy.map(l => l.name).join(', ')}
            ) can be folded into Sites. The old rows are disabled, not deleted.
          </p>
          <Button size="sm" variant="outline" disabled={busy === 'legacy'} onClick={importLegacy}>
            {busy === 'legacy' ? 'Importing…' : 'Import legacy connections'}
          </Button>
        </div>
      )}

      {showProvisioning && (
        <div className="space-y-2 border-b border-white/8 p-3">
          <p className="text-xs text-white/50">
            Paste the JSON returned by the site's provisioning hook (
            <code className="text-white/60">POST /wp-json/artivio/v1/provision-agent</code>
            {' '}
            or
            {' '}
            <code className="text-white/60">wp artivio provision-agent</code>
            ). The site is registered and tested in one step.
          </p>
          <textarea
            className={`
              ${inputClass}
              h-20 font-mono text-[11px]
            `}
            placeholder={'{"site_url": "https://…", "username": "artivio-agent", "app_password": "…"}'}
            value={provisioning}
            onChange={e => setProvisioning(e.target.value)}
          />
          <Button size="sm" disabled={busy === 'prov' || !provisioning.trim()} onClick={importProvisioning}>
            {busy === 'prov' ? 'Adding…' : 'Add and test'}
          </Button>
        </div>
      )}

      {form && (
        <form onSubmit={save} className="space-y-3 border-b border-white/8 p-3">
          <div className="
            grid gap-2
            sm:grid-cols-2
          "
          >
            <label className="space-y-1 text-[11px] text-white/45">
              Label
              <input className={inputClass} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="noah-build" required />
            </label>
            <label className="space-y-1 text-[11px] text-white/45">
              Site URL
              <input className={inputClass} value={form.siteUrl} onChange={e => setForm({ ...form, siteUrl: e.target.value })} placeholder="https://build.example.com" required />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-white/45">Credential</span>
              <button
                type="button"
                className="
                  text-[11px] text-white/35
                  hover:text-white/60
                "
                onClick={() => {
                  const next = !advanced;
                  setAdvanced(next);
                  setForm({ ...form, authScheme: next ? form.authScheme : 'basic' });
                }}
              >
                {advanced ? 'Advanced ▾' : 'Advanced ▸'}
              </button>
            </div>
            {advanced && (
              <label className="
                flex items-center gap-2 text-[11px] text-white/45
              "
              >
                <input
                  type="checkbox"
                  checked={form.authScheme === 'bearer'}
                  onChange={e => setForm({ ...form, authScheme: e.target.checked ? 'bearer' : 'basic' })}
                />
                Use a custom token instead of an application password (legacy site plugins). The platform adds the right header — paste the token only.
              </label>
            )}
            <div className="
              grid gap-2
              sm:grid-cols-2
            "
            >
              {form.authScheme === 'basic' && (
                <input className={inputClass} value={form.authUser} onChange={e => setForm({ ...form, authUser: e.target.value })} placeholder="Username (e.g. artivio-agent)" required />
              )}
              <input
                className={inputClass}
                type="password"
                value={form.authSecret}
                onChange={e => setForm({ ...form, authSecret: e.target.value })}
                placeholder={form.id ? 'Stored — blank keeps it' : form.authScheme === 'basic' ? 'Application password (xxxx xxxx xxxx …)' : 'Token'}
                required={!form.id}
                autoComplete="off"
              />
            </div>
            {form.authScheme === 'basic' && (
              <p className="text-[11px] text-white/30">
                WP Admin → Users → Profile → Application Passwords. The agent user should be an Administrator for builder abilities.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[11px] text-white/45">
              <input type="checkbox" checked={form.sshEnabled} onChange={e => setForm({ ...form, sshEnabled: e.target.checked })} />
              WP-CLI over SSH (optional)
            </label>
            {form.sshEnabled && (
              <div className="space-y-2">
                <div className="
                  grid gap-2
                  sm:grid-cols-[2fr_1fr_2fr]
                "
                >
                  <input className={inputClass} value={form.sshHost} onChange={e => setForm({ ...form, sshHost: e.target.value })} placeholder="Host (45.13.134.129)" />
                  <input className={inputClass} value={form.sshPort} onChange={e => setForm({ ...form, sshPort: e.target.value })} placeholder="Port" />
                  <input className={inputClass} value={form.sshUser} onChange={e => setForm({ ...form, sshUser: e.target.value })} placeholder="User (u195312244)" />
                </div>
                <input className={inputClass} value={form.wpPath} onChange={e => setForm({ ...form, wpPath: e.target.value })} placeholder="WP path — /home/…/domains/site.com/public_html (the folder with wp-config.php)" />
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={`
                      ${selectClass}
                      sm:w-auto
                    `}
                    value={form.sshKeyId}
                    onChange={e => setForm({ ...form, sshKeyId: e.target.value })}
                  >
                    {sshKeys.length === 0 && <option value="">No workspace key yet</option>}
                    {sshKeys.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                  </select>
                  <Button type="button" size="sm" variant="outline" disabled={busy === 'key'} onClick={generateKey}>
                    {busy === 'key' ? 'Generating…' : sshKeys.length === 0 ? 'Generate workspace key' : 'Generate another key'}
                  </Button>
                  {selectedKey && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setShownKey(shownKey === selectedKey.id ? null : selectedKey.id)}>
                      {shownKey === selectedKey.id ? 'Hide public key' : 'Show public key'}
                    </Button>
                  )}
                </div>
                {selectedKey && shownKey === selectedKey.id && (
                  <div>
                    <p className="mb-1 text-[11px] text-white/45">
                      Add this PUBLIC key on the host once (Hostinger: Websites → Advanced → SSH Access → Add SSH key); it works for every site on that account.
                      {' '}
                      {selectedKey.fingerprint}
                    </p>
                    <textarea
                      readOnly
                      className={`
                        ${inputClass}
                        h-16 font-mono text-[11px]
                      `}
                      value={selectedKey.publicKey}
                      onFocus={e => e.currentTarget.select()}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] text-white/45">Policy</span>
            {(['rest', 'mcp', 'cli'] as Channel[]).map(ch => (
              <label
                key={ch}
                className="flex items-center gap-1 text-[11px] text-white/45"
              >
                <span className="uppercase">{ch}</span>
                <select
                  className="
                    rounded-full border border-white/15 bg-white/4 px-2 py-0.5
                    text-[10px] text-white/70
                  "
                  value={form.policy[ch]}
                  onChange={e => setForm({ ...form, policy: { ...form.policy, [ch]: e.target.value as PolicyValue } })}
                >
                  <option value="auto">Auto-run</option>
                  <option value="ask">Ask first</option>
                  <option value="blocked">Blocked</option>
                </select>
              </label>
            ))}
            <label className="
              ml-auto flex items-center gap-1 text-[11px] text-white/45
            "
            >
              <input type="checkbox" checked={form.isDefault} onChange={e => setForm({ ...form, isDefault: e.target.checked })} />
              Default site
            </label>
          </div>

          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy === 'save' || !form.label || !form.siteUrl} onClick={testFromForm}>
              {busy === 'save' ? 'Working…' : 'Test connection'}
            </Button>
            <Button type="submit" size="sm" disabled={busy === 'save'}>
              {busy === 'save' ? 'Saving…' : form.id ? 'Save' : 'Save & test'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setForm(null)}>Cancel</Button>
          </div>
          {form.id && reports[form.id] && <ReportView report={reports[form.id]!} />}
        </form>
      )}

      <div className="divide-y divide-white/6">
        {sites.length === 0 && !form && (
          <p className="p-3 text-xs text-white/40">
            No sites yet. Add one with its URL and an application password — the MCP endpoint, builder and versions are discovered automatically.
          </p>
        )}
        {sites.map((s) => {
          const report = reports[s.id] ?? s.lastTestReport;
          return (
            <div key={s.id} className="px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`
                        size-1.5 rounded-full
                        ${STATUS_DOT[s.status]}
                      `}
                      title={s.status}
                    />
                    <span className="text-sm font-medium text-white">{s.label}</span>
                    {s.isDefault && (
                      <span className="
                        rounded-sm bg-indigo-400/15 px-1.5 py-0.5 text-[10px]
                        text-indigo-300
                      "
                      >
                        default
                      </span>
                    )}
                    <span className="text-[10px] text-white/35">{s.status}</span>
                    {s.builder && (
                      <span className="
                        rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px]
                        text-white/50
                      "
                      >
                        {s.builder}
                        {s.builderVersion ? ` ${s.builderVersion}` : ''}
                      </span>
                    )}
                    {s.wpVersion && (
                      <span className="text-[10px] text-white/35">
                        WP
                        {s.wpVersion}
                      </span>
                    )}
                    {s.phpVersion && (
                      <span className="text-[10px] text-white/35">
                        PHP
                        {s.phpVersion}
                      </span>
                    )}
                  </div>
                  <p className="truncate pl-3.5 text-xs text-white/35">
                    {s.siteUrl}
                    {' · '}
                    {s.authScheme === 'basic' ? `${s.authUser} / ${s.secretMask}` : `token ${s.secretMask}`}
                    {s.ssh ? ` · ssh ${s.ssh.user}@${s.ssh.host}:${s.ssh.port}` : ''}
                  </p>
                  <p className="pl-3.5 text-[10px] text-white/30">
                    {['rest', 'mcp', 'cli'].map(ch => `${ch} ${s.capabilities[ch as Channel] ? '✓' : '–'}`).join(' · ')}
                    {s.capabilities.mcp_tools.length ? ` · ${s.capabilities.mcp_tools.length} MCP tools` : ''}
                    {s.agentConnectorVersion ? ` · connector ${s.agentConnectorVersion}` : ''}
                    {s.mcpEndpointUrl ? ` · ${s.mcpEndpointUrl.replace(s.siteUrl, '')}` : ''}
                    {s.lastTestAt ? ` · tested ${new Date(s.lastTestAt).toLocaleString()}` : ''}
                  </p>
                  <div className="
                    mt-1.5 flex flex-wrap items-center gap-3 pl-3.5
                  "
                  >
                    {(['rest', 'mcp', 'cli'] as Channel[]).map(ch => policyButton(s, ch))}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button variant="outline" size="sm" disabled={busy === `test:${s.id}`} onClick={() => test(s.id)}>
                    {busy === `test:${s.id}` ? 'Testing…' : 'Test'}
                  </Button>
                  {canManage && s.authScheme === 'basic' && (
                    <Button variant="outline" size="sm" disabled={busy === `rotate:${s.id}`} onClick={() => rotate(s)}>
                      {busy === `rotate:${s.id}` ? 'Rotating…' : 'Rotate'}
                    </Button>
                  )}
                  {canManage && <Button variant="outline" size="sm" onClick={() => startEdit(s)}>Edit</Button>}
                  {canManage && !s.isDefault && sites.length > 1 && <Button variant="outline" size="sm" onClick={() => makeDefault(s)}>Make default</Button>}
                  <Button variant="outline" size="sm" onClick={() => loadActivity(s)}>{openActivity === s.id ? 'Hide activity' : 'Activity'}</Button>
                  {canManage && <Button variant="outline" size="sm" onClick={() => remove(s)}>Remove</Button>}
                </div>
              </div>
              {report && (
                <div className="mt-1 pl-3.5">
                  <button
                    type="button"
                    className="
                      text-[11px] text-white/40
                      hover:text-white/70
                    "
                    onClick={() => setOpenReport(openReport === s.id ? null : s.id)}
                  >
                    {openReport === s.id ? 'Hide report ▾' : `Last report: ${report.rows.filter(r => r.status === 'ok').length}/${report.rows.filter(r => r.status !== 'skip').length} ✅ ▸`}
                  </button>
                  {openReport === s.id && (
                    <>
                      <ReportView report={report} />
                      {canManage && (
                        <button
                          type="button"
                          className="
                            mt-1 text-[11px] text-white/35
                            hover:text-white/60
                          "
                          onClick={() => test(s.id, true)}
                        >
                          Run again with write probe (creates + deletes a draft)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              {openActivity === s.id && (
                <div className="mt-2 pl-3.5">
                  {(activity[s.id] ?? []).length === 0
                    ? <p className="text-[11px] text-white/35">No activity yet.</p>
                    : (
                        <ul className="space-y-0.5 text-[11px] text-white/50">
                          {(activity[s.id] ?? []).map((a, i) => (
                            <li
                              key={`${a.at}-${i}`}
                              className="flex flex-wrap gap-2"
                            >
                              <span className="text-white/30">{new Date(a.at).toLocaleString()}</span>
                              <span>{a.action.replace('wp_site.', '')}</span>
                              {typeof a.detail.channel === 'string' && (
                                <span className="uppercase">
                                  {String(a.detail.channel)}
                                </span>
                              )}
                              {typeof a.detail.tool === 'string' && (
                                <span className="text-white/70">
                                  {String(a.detail.tool)}
                                </span>
                              )}
                              {a.detail.ok === false && (
                                <span className="text-rose-300">
                                  failed
                                </span>
                              )}
                              {typeof a.detail.ms === 'number' && (
                                <span className="text-white/30">
                                  {`${a.detail.ms}ms`}
                                </span>
                              )}
                              {typeof a.detail.status === 'string' && <span>{String(a.detail.status)}</span>}
                            </li>
                          ))}
                        </ul>
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
