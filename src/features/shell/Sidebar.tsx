'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from '@/components/BrandLogo';

type Ws = { id: string; name: string; slug: string; role: string };

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  admin: 'M12 3l7.5 3.5v5c0 4.5-3.2 8.4-7.5 9.5-4.3-1.1-7.5-5-7.5-9.5v-5L12 3z',
  files: 'M6 3.5h7l5 5V20a.5.5 0 01-.5.5h-11A.5.5 0 016 20V4a.5.5 0 010-.5zM13 3.5V9h5',
  account: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 114 2c-.9.7-1.5 1.2-1.5 2.5M12 17h.01',
};

const Icon = ({ name }: { name: string }) => (
  <svg
    viewBox="0 0 24 24"
    className="size-4 shrink-0 fill-none stroke-current stroke-[1.6]"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={PATHS[name]} />
  </svg>
);

export const Sidebar = (props: {
  workspaces: Ws[];
  activeSlug?: string;
  isAdmin: boolean;
  userEmail: string;
  userName?: string | null;
}) => {
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);

  const t = params.get('t');
  const active = props.workspaces.find(w => w.slug === (props.activeSlug ?? t)) ?? props.workspaces[0];

  const nav = [
    { href: active ? `/dashboard?t=${active.slug}` : '/dashboard', label: 'Workspace', icon: 'home', match: /\/dashboard$/ },
    { href: active ? `/dashboard/files?t=${active.slug}` : '/dashboard/files', label: 'Files', icon: 'files', match: /\/dashboard\/files/ },
    ...(props.isAdmin ? [{ href: '/dashboard/admin', label: 'Platform', icon: 'admin', match: /\/dashboard\/admin/ }] : []),
    { href: '/dashboard/settings', label: 'Account', icon: 'account', match: /\/dashboard\/settings/ },
    { href: '/dashboard/help', label: 'Help', icon: 'help', match: /\/dashboard\/help/ },
  ];

  const body = (
    <div className="flex h-full flex-col gap-7 p-5">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-1">
        <BrandMark size={30} />
        <span className="text-[15px] font-bold tracking-tight">Artivio</span>
      </Link>

      {props.workspaces.length > 0 && (
        <div>
          <p className="
            px-1 pb-2 text-[10px] font-semibold tracking-[0.14em]
            text-white/35 uppercase
          "
          >
            Workspaces
          </p>
          <div className="space-y-1">
            {props.workspaces.map((w) => {
              const isActive = w.id === active?.id;
              return (
                <Link
                  key={w.id}
                  href={`/dashboard?t=${w.slug}`}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm transition ${
                    isActive
                      ? 'nav-active font-medium text-white'
                      : `
                        text-white/55
                        hover:bg-white/5 hover:text-white
                      `
                  }`}
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ${
                      isActive ? 'grad-fill text-white glow-ring' : 'bg-white/8 text-white/60'
                    }`}
                  >
                    {w.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate">{w.name}</span>
                  {isActive && <span className="pulse-dot ml-auto size-1.5 rounded-full bg-emerald-400" />}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <nav className="space-y-1">
        <p className="
          px-1 pb-2 text-[10px] font-semibold tracking-[0.14em] text-white/35
          uppercase
        "
        >
          Navigate
        </p>
        {nav.map((item) => {
          const isActive = item.match.test(pathname);
          return (
            <Link
              key={item.label}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition ${
                isActive
                  ? 'nav-active font-medium text-white'
                  : `
                    text-white/55
                    hover:bg-white/5 hover:text-white
                  `
              }`}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto">
        <div className="glass flex items-center gap-2.5 p-2.5">
          <span className="
            grad-fill flex size-8 shrink-0 items-center justify-center
            rounded-lg text-xs font-bold text-white
          "
          >
            {(props.userName ?? props.userEmail).slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-white/90">
              {props.userName ?? 'Signed in'}
            </p>
            <p className="truncate text-[11px] text-white/40">{props.userEmail}</p>
          </div>
          <a
            href="/api/auth/logout"
            title="Sign out"
            className="
              text-white/40 transition
              hover:text-white
            "
          >
            <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.6]" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 17l5-5-5-5M20 12H9M13 3H6a1 1 0 00-1 1v16a1 1 0 001 1h7" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile bar */}
      <div className="
        flex items-center justify-between border-b border-white/10 px-4 py-3
        lg:hidden
      "
      >
        <span className="flex items-center gap-2">
          <BrandMark size={24} />
          <span className="text-sm font-bold">Artivio</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="rounded-lg border border-white/15 px-2.5 py-1 text-xs"
        >
          Menu
        </button>
      </div>
      {open && <div className="border-b border-white/10 lg:hidden">{body}</div>}

      {/* Desktop rail */}
      <aside className="
        sticky top-0 hidden h-svh w-64 shrink-0 border-r border-white/8
        bg-white/[0.02] backdrop-blur-xl
        lg:block
      "
      >
        {body}
      </aside>
    </>
  );
};
