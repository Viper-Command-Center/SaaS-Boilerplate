'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

type Mode = 'sign-in' | 'sign-up';

/**
 * Email + password form.
 * - Sign-in: if the account has 2FA, the server answers `twoFactorRequired`
 *   and we reveal the authenticator-code field.
 * - Sign-up: Artivio is invite-only, so unless the platform has no users yet
 *   (bootstrap) or public signup is explicitly enabled, we show the waitlist.
 */
export const AuthForm = (props: { mode: Mode }) => {
  const router = useRouter();
  const isSignUp = props.mode === 'sign-up';

  const [signupOpen, setSignupOpen] = useState<boolean | null>(isSignUp ? null : true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    if (!isSignUp) {
      return;
    }
    fetch('/api/auth/signup')
      .then(r => r.json())
      .then(d => setSignupOpen(Boolean(d.open)))
      .catch(() => setSignupOpen(false));
  }, [isSignUp]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(isSignUp ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isSignUp
            ? { email, password, firstName: firstName || undefined }
            : { email, password, code: code || undefined },
        ),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        if (data?.twoFactorRequired) {
          setNeedsCode(true);
          setError(code ? 'That code is not valid. Try again.' : null);
        } else {
          setError(data?.error ?? 'Something went wrong. Please try again.');
        }
        setBusy(false);
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
      setBusy(false);
    }
  };

  const requestReset = async () => {
    if (!email) {
      setError('Enter your email first, then click "Forgot password".');
      return;
    }
    await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }).catch(() => {});
    setResetSent(true);
  };

  const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  // ── Invite-only: the waitlist screen ──
  if (isSignUp && signupOpen === false) {
    return (
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Artivio is invite-only</h1>
        <p className="text-sm text-muted-foreground">
          We&apos;re onboarding a first group of businesses and agencies. Tell us
          about your project and we&apos;ll set up your workspace.
        </p>
        <a
          href="mailto:hello@artivio.ai?subject=Artivio%20waitlist&body=Business%2Fagency%3A%0AWebsite%3A%0AWhat%20I%27d%20use%20Artivio%20for%3A%0A"
          className="
            inline-block w-full rounded-md bg-primary px-4 py-2 text-sm
            font-semibold text-primary-foreground
          "
        >
          Join the waitlist
        </a>
        <p className="text-sm text-muted-foreground">
          Already have an account?
          {' '}
          <a className="text-primary underline" href="/sign-in">Sign in</a>
        </p>
      </div>
    );
  }

  if (isSignUp && signupOpen === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold">
          {isSignUp ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isSignUp
            ? 'Set up the first Artivio administrator account.'
            : 'Sign in to your Artivio Command Center.'}
        </p>
      </div>

      {isSignUp && (
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="firstName">First name</label>
          <input id="firstName" className={inputClass} value={firstName} onChange={e => setFirstName(e.target.value)} autoComplete="given-name" />
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="email">Email</label>
        <input id="email" type="email" required className={inputClass} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" disabled={needsCode} />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          required
          minLength={isSignUp ? 10 : 1}
          className={inputClass}
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          disabled={needsCode}
        />
        {isSignUp && <p className="mt-1 text-xs text-muted-foreground">At least 10 characters.</p>}
      </div>

      {needsCode && (
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="code">Authentication code</label>
          <input
            id="code"
            className={inputClass}
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="6-digit code or backup code"
            autoComplete="one-time-code"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          <p className="mt-1 text-xs text-muted-foreground">
            From your authenticator app. You can also use a backup code.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      {resetSent && (
        <p className="text-sm text-green-600">
          If that email has an account, a reset link is on its way.
        </p>
      )}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Please wait…' : needsCode ? 'Verify & sign in' : isSignUp ? 'Create account' : 'Sign in'}
      </Button>

      {!isSignUp && !needsCode && (
        <button type="button" onClick={requestReset} className="w-full text-center text-sm text-muted-foreground underline">
          Forgot password?
        </button>
      )}

      <p className="text-center text-sm text-muted-foreground">
        {isSignUp
          ? (
              <>
                Already have an account?
                {' '}
                <a className="text-primary underline" href="/sign-in">Sign in</a>
              </>
            )
          : (
              <>
                Need access?
                {' '}
                <a className="text-primary underline" href="mailto:hello@artivio.ai">Request an invite</a>
              </>
            )}
      </p>
    </form>
  );
};
