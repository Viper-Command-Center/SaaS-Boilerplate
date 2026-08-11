'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Shown to a user whose account still carries `mustChangePassword` — i.e. they
 * are signing in with a password an administrator generated for them.
 *
 * 🔴 That password was emailed in plaintext and is sitting in their inbox
 * forever. Before this page existed, `mustChangePassword` was set on the user
 * row, returned by /api/auth/login, and then thrown away by the sign-in form —
 * so an invited client kept the emailed credential for the life of the account.
 *
 * The redirect that lands people here is in the dashboard layout (server side),
 * not in this form, so skipping the client route does not skip the change.
 */
export const FirstLoginForm = (props: { email: string }) => {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (password === currentPassword) {
      setError('Please choose a password different from the one you were sent.');
      return;
    }

    setBusy(true);
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword: password }),
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(data?.error ?? 'Could not update your password.');
      return;
    }
    router.push('/dashboard');
    router.refresh();
  };

  const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold">Choose your password</h1>
        <p className="text-sm text-muted-foreground">
          You signed in with a temporary password. Set your own to continue.
        </p>
        <p className="text-xs text-muted-foreground">{props.email}</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="current-password">
          Temporary password
        </label>
        <input
          id="current-password"
          type="password"
          required
          className={inputClass}
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          required
          minLength={10}
          className={inputClass}
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        <p className="mt-1 text-xs text-muted-foreground">At least 10 characters.</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          required
          minLength={10}
          className={inputClass}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Saving…' : 'Save and continue'}
      </Button>
    </form>
  );
};
