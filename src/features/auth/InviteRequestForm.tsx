'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

const COUNTS = ['Just my own business', '2–5 businesses / clients', '6–20', '20+'];

export const InviteRequestForm = () => {
  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    website: '',
    clientCount: COUNTS[0]!,
    useCase: '',
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch('/api/invite-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(data?.error ?? 'Could not send your request. Please email hello@artivio.ai.');
      return;
    }
    setDone(true);
  };

  const input = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-ring';

  if (done) {
    return (
      <div className="w-full max-w-md space-y-3 text-center">
        <div className="
          mx-auto flex size-12 items-center justify-center rounded-full
          bg-green-100
        "
        >
          <svg viewBox="0 0 24 24" className="size-6 fill-none stroke-green-600 stroke-2">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold">Request received</h1>
        <p className="text-sm text-muted-foreground">
          Thanks
          {form.name ? `, ${form.name.split(' ')[0]}` : ''}
          {' '}
          — we&apos;ll review your project and get back to you at
          {' '}
          <span className="font-medium">{form.email}</span>
          . Most invites go out within a day or two.
        </p>
        <a className="inline-block text-sm text-primary underline" href="/">Back to the homepage</a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full max-w-md space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Request an invite</h1>
        <p className="text-sm text-muted-foreground">
          Artivio is invite-only while we onboard our first group. Tell us a
          little about your project.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="ir-name">Your name *</label>
          <input id="ir-name" className={input} required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="ir-email">Work email *</label>
          <input id="ir-email" type="email" className={input} required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="ir-company">Company</label>
          <input id="ir-company" className={input} value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="ir-website">Website</label>
          <input id="ir-website" className={input} placeholder="yourbusiness.com" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="ir-count">How many businesses or clients would you manage?</label>
        <select id="ir-count" className={input} value={form.clientCount} onChange={e => setForm({ ...form, clientCount: e.target.value })}>
          {COUNTS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="ir-use">What would you want the agent to do first?</label>
        <textarea
          id="ir-use"
          className={`${input} h-24 resize-none`}
          placeholder="e.g. run our social posting, keep our SEO blog going, manage ads, update our website…"
          value={form.useCase}
          onChange={e => setForm({ ...form, useCase: e.target.value })}
        />
      </div>

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Sending…' : 'Request an invite'}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?
        {' '}
        <a className="text-primary underline" href="/sign-in">Sign in</a>
      </p>
    </form>
  );
};
