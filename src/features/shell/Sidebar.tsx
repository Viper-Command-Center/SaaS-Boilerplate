'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BrandLogo } from '@/components/BrandLogo';

type Ws = { id: string; name: string; slug: string; role: string };

const ICONS: Record<string, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5" />,
  admin: <path d="M12 3l7.5 3.5v5c0 4.5-3.2 8.4-7.5 9.5-4.3-1.1-7.5-5-7.5-9.5v-5L12 3z" />,
  account: <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0" />,
  help: <path d="M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 114 2c-.9.7-1.5 1.2-1.5 2.5M12 17h.01" />,
};

const Icon = ({ name }: { name: string }) => (
  <svg
    viewBox="0 0 24 24"
    className="size-4 shrink-0 fill-none stroke-current stroke-[1.75]"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {ICONS[name]}
  </svg>
);

export const Sidebar = (props: {
  workspaces: Ws[];
  activeSlug?: string;
  isAdmin: boolean;
  userEmail: string;
}) => {
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);

  const t = params.get('t');
  const active = props.workspaces.find(w => w.slug === (props.activeSlug ?? t)) ?? props.workspaces[0];

  const nav = [
    { href: active ? `/dashboard?t=${active.slug}` : '/dashboard', label: 'Workspace', icon: 'home', match: /\/dashboard$/ },
    ...(props.isAdmin ? [{ href: '/dashboard/admin', label: 'Platform admin', icon: 'admin', match: /\/dashboard\/admin/ }] : []),
    { href: '/dashboard/settings', label: 'Account', icon: 'account', match: /\/dashboard\/settings/ },
    { href: '/dashboard/help', label: 'Help', icon: 'help', match: /\/dashboard\/help/ },
  ];

  const body = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link href="/dashboard" className="px-2">
        <BrandLogo size={26} />
      </Link>

      {/* Workspace switcher */}
      {props.workspaces.length > 0 && (
        <div>
          <p className="
            px-2 pb-2 text-[11px] font-semibold tracking-wider
            text-muted-foreground uppercase
          "
          >
            Workspaces
          </p>
          <div className="space-y-0.5">
            {props.workspaces.map((w) => {
              const isActive = w.id === active?.id;
              return (
                <Link
                  key={w.id}
                  href={`/dashboard?t=${w.slug}`}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                    isActive
                      ? 'bg-foreground/5 font-medium text-foreground'
                      : `
                        text-muted-foreground
                        hover:bg-foreground/5 hover:text-foreground
                      `
                  }`}
                >
                  <span
                    className="
                      flex size-6 shrink-0 items-center justify-center
                      rounded-md text-[10px] font-bold text-white
                    "
                    style={{
                      background: isActive
                        ? 'linear-gradient(135deg,#6366F1,#D946EF)'
                        : 'var(--muted-foreground)',
                    }}
                  >
                    {w.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate">{w.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Nav */}
      <nav className="space-y-0.5">
        {nav.map((item) => {
          const isActive = item.match.test(pathname);
          return (
            <Link
              key={item.label}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition ${
                isActive
                  ? 'bg-foreground/5 font-medium text-foreground'
                  : `
                    text-muted-foreground
                    hover:bg-foreground/5 hover:text-foreground
                  `
              }`}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto space-y-2 px-2">
        <p className="truncate text-xs text-muted-foreground">{props.userEmail}</p>
        <a
          href="/api/auth/logout"
          className="
            block text-xs text-muted-foreground underline
            hover:text-foreground
          "
        >
          Sign out
        </a>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile bar */}
      <div className="
        flex items-center justify-between border-b px-4 py-3
        lg:hidden
      "
      >
        <BrandLogo size={24} />
        <button type="button" onClick={() => setOpen(o => !o)} className="rounded-md border px-2 py-1 text-sm">
          Menu
        </button>
      </div>
      {open && (
        <div className="border-b bg-background lg:hidden">{body}</div>
      )}

      {/* Desktop rail */}
      <aside className="
        sticky top-0 hidden h-svh w-60 shrink-0 border-r bg-background
        lg:block
      "
      >
        {body}
      </aside>
    </>
  );
};
