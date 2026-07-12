'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Shared email+password form for sign-in and sign-up.
 * Posts JSON to /api/auth/login or /api/auth/signup, then goes to /dashboard.
 */
export const AuthForm = (props: { mode: 'sign-in' | 'sign-up' }) => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = props.mode === 'sign-up';

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
            : { email, password },
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Something went wrong. Please try again.');
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

  const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold">
          {isSignUp ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isSignUp ? 'Set up your Artivio Command Center login.' : 'Sign in to your Artivio Command Center.'}
        </p>
      </div>

      {isSignUp && (
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="firstName">First name</label>
          <input
            id="firstName"
            className={inputClass}
            value={firstName}
            onChange={e => setFirstName(e.target.value)}
            autoComplete="given-name"
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          className={inputClass}
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
        />
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
        />
        {isSignUp && (
          <p className="mt-1 text-xs text-muted-foreground">At least 10 characters.</p>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600" role="alert">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
      </Button>

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
                New here?
                {' '}
                <a className="text-primary underline" href="/sign-up">Create an account</a>
              </>
            )}
      </p>
    </form>
  );
};
