'use client';

import { useState } from 'react';

export function OptInForm() {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consent) {
      setStatus({ ok: false, message: 'Please tick the box to agree before subscribing.' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/messaging/optin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name: name || undefined, consent: true }),
      });
      const data = await res.json().catch(() => null);
      setStatus(res.ok
        ? { ok: true, message: data?.message ?? 'Subscribed.' }
        : { ok: false, message: data?.error ?? 'Something went wrong. Please try again.' });
    } catch {
      setStatus({ ok: false, message: 'Network error. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200';

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <div>
        <label htmlFor="optin-name" className="mb-1 block text-sm font-medium text-slate-700">
          First name (optional)
        </label>
        <input id="optin-name" className={input} value={name} onChange={e => setName(e.target.value)} placeholder="Alex" />
      </div>

      <div>
        <label htmlFor="optin-phone" className="mb-1 block text-sm font-medium text-slate-700">
          WhatsApp number
        </label>
        <input
          id="optin-phone"
          className={input}
          value={phone}
          onChange={e => setPhone(e.target.value)}
          placeholder="+1 555 123 4567"
          inputMode="tel"
          required
        />
        <p className="mt-1 text-xs text-slate-500">Use international format, starting with your country code (e.g. +1).</p>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={consent}
          onChange={e => setConsent(e.target.checked)}
          className="mt-0.5 size-4"
        />
        <span>
          I agree to receive WhatsApp messages from my Artivio AI assistant —
          including updates, approval requests, and replies to my messages.
          Message and data rates may apply. Reply
          {' '}
          <strong>STOP</strong>
          {' '}
          at any time to opt out, or
          {' '}
          <strong>HELP</strong>
          {' '}
          for help. See our
          {' '}
          <a href="/privacy" className="text-indigo-600 underline">Privacy Policy</a>
          {' '}
          and
          {' '}
          <a href="/terms" className="text-indigo-600 underline">Terms</a>
          .
        </span>
      </label>

      {status && (
        <p className={`text-sm ${status.ok ? 'text-emerald-600' : 'text-rose-600'}`} role="status">
          {status.message}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="
          w-full rounded-lg bg-slate-900 px-4 py-2.5 font-semibold text-white
          hover:bg-slate-800 disabled:opacity-50
        "
      >
        {busy ? 'Subscribing…' : 'Subscribe on WhatsApp'}
      </button>
    </form>
  );
}
