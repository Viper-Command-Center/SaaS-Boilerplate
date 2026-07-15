import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { BrandLogo } from '@/components/BrandLogo';
import { OptInForm } from '@/features/messaging/OptInForm';

export const metadata: Metadata = {
  title: 'Get WhatsApp updates from your Artivio assistant',
  description: 'Opt in to receive WhatsApp messages from your Artivio AI assistant. Reply STOP at any time to opt out.',
};

export default async function WhatsAppOptInPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <main className="min-h-screen bg-white text-slate-800">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" aria-label="Artivio home"><BrandLogo /></Link>
        <Link href="/sign-in" className="text-sm text-slate-500 hover:text-slate-900">Sign in</Link>
      </header>

      <section className="mx-auto max-w-lg px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Chat with your Artivio assistant on WhatsApp
        </h1>
        <p className="mt-4 leading-relaxed text-slate-600">
          Get updates, approve actions, and message your AI assistant right from
          WhatsApp. Enter your number and agree below to subscribe.
        </p>

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-800">What you&apos;ll receive</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>work updates and completed-task summaries from your assistant;</li>
            <li>requests to approve actions before they happen;</li>
            <li>replies to messages you send it.</li>
          </ul>
          <p className="mt-3">
            You can opt out any time by replying
            {' '}
            <strong>STOP</strong>
            . Message and data rates may apply.
          </p>
        </div>

        <OptInForm />
      </section>

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

export const dynamic = 'force-static';
