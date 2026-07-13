'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Account security: change password, enrol/disable TOTP two-factor auth.
 * The QR is rendered as a link to the otpauth:// URI plus the manual key —
 * every authenticator app accepts manual entry, so no QR dependency is needed.
 */
export const AccountSettings = () => {
  const [enabled, setEnabled] = useState(false);
  const [backupRemaining, setBackupRemaining] = useState(0);
  const [enrolling, setEnrolling] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(() => {
    fetch('/api/auth/2fa')
      .then(r => r.json())
      .then((d) => {
        setEnabled(Boolean(d.enabled));
        setBackupRemaining(Number(d.backupCodesRemaining ?? 0));
      })
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  const startEnrol = async () => {
    setError(null);
    const res = await fetch('/api/auth/2fa', { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not start setup.');
      return;
    }
    setEnrolling({ secret: data.secret, otpauthUrl: data.otpauthUrl });
  };

  const confirmEnrol = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/auth/2fa', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Invalid code.');
      return;
    }
    setBackupCodes(data.backupCodes ?? []);
    setEnrolling(null);
    setCode('');
    load();
  };

  const disable2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/auth/2fa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: disablePassword }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not disable.');
      return;
    }
    setDisablePassword('');
    setBackupCodes(null);
    setMsg('Two-factor authentication disabled.');
    load();
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMsg(null);
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'Could not change password.');
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setMsg('Password changed.');
  };

  const input = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-6">
      {msg && <p className="rounded-md bg-muted p-3 text-sm">{msg}</p>}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      {/* Two-factor */}
      <div className="rounded-lg border bg-background">
        <div className="border-b px-4 py-3">
          <span className="text-sm font-semibold">Two-factor authentication</span>
          <p className="text-xs text-muted-foreground">
            A 6-digit code from your authenticator app, required at every sign-in.
          </p>
        </div>

        <div className="space-y-4 p-4">
          {!enabled && !enrolling && !backupCodes && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">Currently off.</p>
              <Button size="sm" onClick={startEnrol}>Turn on 2FA</Button>
            </div>
          )}

          {enrolling && (
            <form onSubmit={confirmEnrol} className="space-y-3">
              <p className="text-sm">
                1. Open your authenticator app (Google Authenticator, 1Password, Authy…)
                and add an account.
              </p>
              <p className="text-sm">
                2. Scan or open this link on your phone, or type the key manually:
              </p>
              <a href={enrolling.otpauthUrl} className="block text-xs break-all text-primary underline">
                {enrolling.otpauthUrl}
              </a>
              <p className="rounded bg-muted p-3 font-mono text-sm tracking-widest">
                {enrolling.secret}
              </p>
              <p className="text-sm">3. Enter the 6-digit code it shows:</p>
              <input className={input} value={code} onChange={e => setCode(e.target.value)} placeholder="123456" inputMode="numeric" />
              <div className="flex gap-2">
                <Button type="submit" size="sm">Verify &amp; enable</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEnrolling(null)}>Cancel</Button>
              </div>
            </form>
          )}

          {backupCodes && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-green-600">2FA is on. Save these backup codes now — they are shown once.</p>
              <div className="grid grid-cols-2 gap-2 rounded bg-muted p-3 font-mono text-sm">
                {backupCodes.map(c => <span key={c}>{c}</span>)}
              </div>
              <Button size="sm" variant="outline" onClick={() => setBackupCodes(null)}>I&apos;ve saved them</Button>
            </div>
          )}

          {enabled && !backupCodes && (
            <form onSubmit={disable2fa} className="space-y-2">
              <p className="text-sm text-green-600">
                Enabled ·
                {' '}
                {backupRemaining}
                {' '}
                backup codes remaining
              </p>
              <label className="block text-xs font-medium" htmlFor="disable-pw">Confirm your password to turn 2FA off</label>
              <div className="flex gap-2">
                <input id="disable-pw" type="password" className={input} value={disablePassword} onChange={e => setDisablePassword(e.target.value)} />
                <Button type="submit" size="sm" variant="outline">Disable</Button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Password */}
      <div className="rounded-lg border bg-background">
        <div className="border-b px-4 py-3 text-sm font-semibold">Password</div>
        <form onSubmit={changePassword} className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="cur-pw">Current password</label>
              <input id="cur-pw" type="password" className={input} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="new-pw">New password</label>
              <input id="new-pw" type="password" className={input} value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={10} required />
            </div>
          </div>
          <Button type="submit" size="sm">Change password</Button>
        </form>
      </div>
    </div>
  );
};
