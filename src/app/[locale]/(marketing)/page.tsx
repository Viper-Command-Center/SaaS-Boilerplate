import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';

export const metadata: Metadata = {
  title: 'Artivio — an AI employee for every business',
  description: 'Artivio gives each of your businesses and clients a dedicated AI agent that runs marketing and operations end to end — connect any tool via MCP, and keep human approval on everything that matters.',
};

type IndexProps = { params: Promise<{ locale: string }> };

const FEATURES = [
  {
    title: 'An AI agent per workspace',
    body: 'Every business or client gets its own agent with its own memory, brand voice, tools and guardrails. Isolated by design — one platform, many companies.',
  },
  {
    title: 'Any tool, via MCP',
    body: 'Connect SEO data, social publishing, e-commerce, analytics, your GitHub repos — any MCP server. No custom integrations to wait for; if a capability exists, your agent can use it.',
  },
  {
    title: 'Human approval built in',
    body: 'The agent proposes; you approve. Every side-effecting action — a post, an ad spend, a website change — waits in an approvals inbox until you sign off. Full audit trail.',
  },
  {
    title: 'Edit your websites, safely',
    body: 'Connect your GitHub repos and the agent can update pages and publish — a commit triggers your normal deploy. Reviewable change history, like pull requests.',
  },
  {
    title: 'A dashboard that builds itself',
    body: 'Ask for a metric and the agent creates the panel. KPIs, trends and tables assemble around whatever tools you have connected and whatever you care about.',
  },
  {
    title: 'Missions that run 24/7',
    body: 'Set a standing goal — “publish an SEO post every Monday”, “grow trials 20% this quarter” — and the agent works toward it on a schedule, reporting progress honestly.',
  },
];

const STEPS = [
  { n: '1', title: 'Create a workspace', body: 'One per business or client. Set the brand voice and invite the client with the exact access you choose.' },
  { n: '2', title: 'Connect your tools', body: 'Add the MCP servers and credentials for the work — sealed in an encrypted vault, never shared across workspaces.' },
  { n: '3', title: 'Give the agent a goal', body: 'Chat like you would with an employee. It plans, uses its tools, and routes anything risky to your approval.' },
];

export default async function Index(props: IndexProps) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <span className="
            inline-flex size-7 items-center justify-center rounded-md
            bg-slate-900 text-sm text-white
          "
          >
            A
          </span>
          Artivio
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link
            href="/sign-in"
            className="
              font-medium text-slate-600
              hover:text-slate-900
            "
          >
            Sign in
          </Link>
          <a
            href="#waitlist"
            className="
              rounded-lg bg-slate-900 px-4 py-2 font-medium text-white
              hover:bg-slate-700
            "
          >
            Join the waitlist
          </a>
        </nav>
      </header>

      <section className="mx-auto max-w-4xl px-6 pt-16 pb-20 text-center">
        <span className="
          inline-block rounded-full border border-slate-200 bg-slate-50 px-3
          py-1 text-xs font-medium text-slate-600
        "
        >
          AI Command Center · MCP-native · 2026
        </span>
        <h1 className="
          mt-6 text-5xl font-extrabold tracking-tight
          sm:text-6xl
        "
        >
          An AI employee for
          {' '}
          <span className="
            bg-gradient-to-r from-indigo-500 to-fuchsia-500 bg-clip-text
            text-transparent
          "
          >
            every business
          </span>
          .
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600">
          Artivio gives each of your companies and clients a dedicated AI agent
          that runs marketing and operations end to end — connect any tool,
          keep human approval on everything that matters, and let it work while
          you sleep.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a
            href="#waitlist"
            className="
              rounded-lg bg-slate-900 px-6 py-3 font-semibold text-white
              hover:bg-slate-700
            "
          >
            Join the waitlist
          </a>
          <a
            href="#how"
            className="
              rounded-lg border border-slate-300 px-6 py-3 font-semibold
              text-slate-700
              hover:bg-slate-50
            "
          >
            How it works
          </a>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-8">
        <div className="
          grid gap-6
          sm:grid-cols-2
          lg:grid-cols-3
        "
        >
          {FEATURES.map(f => (
            <div key={f.title} className="rounded-2xl border border-slate-200 p-6">
              <h3 className="text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">Up and running in minutes</h2>
        <div className="
          mt-12 grid gap-8
          sm:grid-cols-3
        "
        >
          {STEPS.map(s => (
            <div key={s.n}>
              <div className="
                flex size-9 items-center justify-center rounded-full
                bg-slate-900 font-bold text-white
              "
              >
                {s.n}
              </div>
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="waitlist" className="bg-slate-900 py-20 text-white">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Get early access</h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-300">
            Artivio is onboarding a first group of businesses and agencies. Tell
            us about your project and we&apos;ll set you up with a workspace.
          </p>
          <a
            href="mailto:hello@artivio.ai?subject=Artivio%20waitlist&body=Hi%20Artivio%20team%2C%0A%0AI%27d%20like%20early%20access.%0A%0ABusiness%2Fagency%3A%0AWebsite%3A%0AWhat%20I%27d%20use%20Artivio%20for%3A%0A"
            className="
              mt-8 inline-block rounded-lg bg-white px-8 py-3 font-semibold
              text-slate-900
              hover:bg-slate-100
            "
          >
            Join the waitlist →
          </a>
          <p className="mt-4 text-sm text-slate-400">
            Or email us directly at
            {' '}
            <a href="mailto:hello@artivio.ai" className="underline">hello@artivio.ai</a>
          </p>
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-sm text-slate-500">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span>
            ©
            {' '}
            {new Date().getFullYear()}
            {' '}
            Artivio
          </span>
          <div className="flex gap-5">
            <Link href="/sign-in" className="hover:text-slate-900">Sign in</Link>
            <a href="mailto:hello@artivio.ai" className="hover:text-slate-900">Contact</a>
          </div>
        </div>
      </footer>
    </main>
  );
};
