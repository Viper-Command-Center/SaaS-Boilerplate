import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { BrandLogo, BrandMark } from '@/components/BrandLogo';

/**
 * Split-screen auth shell: brand panel on the left (hidden on mobile), form on
 * the right. The art is generated (gradient mesh + signal grid) — no image
 * assets to ship or optimize.
 */
export default async function CenteredLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <div className="
      grid min-h-svh
      lg:grid-cols-2
    "
    >
      {/* Brand panel */}
      <aside className="
        relative hidden overflow-hidden bg-slate-950 p-12 text-white
        lg:flex lg:flex-col lg:justify-between
      "
      >
        {/* gradient mesh */}
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(60% 60% at 20% 15%, rgba(99,102,241,0.55) 0%, transparent 60%),'
              + 'radial-gradient(50% 50% at 85% 25%, rgba(217,70,239,0.40) 0%, transparent 60%),'
              + 'radial-gradient(60% 60% at 60% 90%, rgba(139,92,246,0.45) 0%, transparent 65%)',
          }}
        />
        {/* signal grid */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px),'
              + 'linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />

        <div className="relative">
          <Link href="/">
            <BrandLogo size={32} wordmarkClassName="text-white" />
          </Link>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl leading-tight font-bold tracking-tight">
            An AI employee for every business.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Connect any tool. Give it a goal. Approve what matters. Artivio runs
            marketing and operations across your companies and clients — and
            reports back honestly.
          </p>

          <div className="mt-10 space-y-3">
            {[
              'Any capability via MCP — no waiting on integrations',
              'Human approval on every action that matters',
              'A dashboard the agent builds around your goals',
            ].map(line => (
              <div key={line} className="flex items-start gap-3 text-sm text-slate-200">
                <span className="
                  mt-0.5 flex size-5 shrink-0 items-center justify-center
                  rounded-full bg-white/10
                "
                >
                  <svg viewBox="0 0 12 12" className="size-3 fill-none stroke-white stroke-2">
                    <path d="M2.5 6.5 L5 9 L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                {line}
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-slate-500">
          ©
          {' '}
          {new Date().getFullYear()}
          {' '}
          Artivio · AI Command Center
        </p>
      </aside>

      {/* Form panel */}
      <main className="flex flex-col items-center justify-center bg-background p-6">
        <div className="mb-8 lg:hidden">
          <Link href="/">
            <BrandMark size={40} />
          </Link>
        </div>
        {props.children}
      </main>
    </div>
  );
}
