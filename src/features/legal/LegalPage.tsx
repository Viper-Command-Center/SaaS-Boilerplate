import type { ReactNode } from 'react';
import Link from 'next/link';
import { BrandLogo } from '@/components/BrandLogo';

/**
 * Shared shell for the public legal pages (/terms, /privacy). Plain, readable
 * prose — these exist to satisfy Twilio/WhatsApp review and to be genuinely
 * clear to a client, not to look like the app.
 */
export function LegalPage({ title, updated, children }: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" aria-label="Artivio home">
          <BrandLogo />
        </Link>
        <Link href="/sign-in" className="text-sm text-slate-500 hover:text-slate-900">Sign in</Link>
      </header>

      <article className="
        mx-auto max-w-3xl px-6 py-10
        [&_a]:text-indigo-600 [&_a]:underline
        [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-slate-900
        [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:font-semibold [&_h3]:text-slate-900
        [&_li]:mt-1.5 [&_p]:mt-4 [&_p]:leading-relaxed
        [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6
      "
      >
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">
          Last updated:
          {' '}
          {updated}
        </p>
        {children}

        <hr className="my-10 border-slate-200" />
        <p className="text-sm text-slate-500">
          Questions? Contact us at
          {' '}
          <a href="mailto:hello@artivio.ai">hello@artivio.ai</a>
          .
        </p>
      </article>

      <footer className="mx-auto max-w-3xl px-6 py-10 text-sm text-slate-500">
        <div className="flex flex-wrap gap-5">
          <Link href="/" className="hover:text-slate-900">Home</Link>
          <Link href="/terms" className="hover:text-slate-900">Terms</Link>
          <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
          <a href="mailto:hello@artivio.ai" className="hover:text-slate-900">Contact</a>
        </div>
      </footer>
    </main>
  );
}
