import Link from 'next/link';
import { ActiveLink } from '@/components/ActiveLink';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';

import { Separator } from '@/components/ui/separator';
import { Logo } from '@/templates/Logo';
import { MobileNavigation } from './MobileNavigation';

export const DashboardHeader = (props: {
  menu: {
    href: string;
    label: string;
  }[];
}) => {
  return (
    <>
      <div className="flex items-center">
        <Link href="/dashboard" className="max-sm:hidden">
          <Logo />
        </Link>

        <nav className="
          ml-3
          max-lg:hidden
        "
        >
          <ul className="
            flex flex-row items-center gap-x-3 text-lg font-medium
            [&_a]:opacity-75
            [&_a:hover]:opacity-100
          "
          >
            {props.menu.map(item => (
              <li key={item.href}>
                <ActiveLink href={item.href}>{item.label}</ActiveLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div>
        <ul className="flex items-center gap-x-1.5">
          <li className="lg:hidden">
            <MobileNavigation menu={props.menu} />
          </li>

          <li>
            <LocaleSwitcher />
          </li>

          <li>
            <Separator orientation="vertical" className="h-4" />
          </li>

          <li>
            <a
              href="/api/auth/logout"
              className="
                px-2 py-1.5 text-sm font-medium opacity-75
                hover:opacity-100
              "
            >
              Sign out
            </a>
          </li>
        </ul>
      </div>
    </>
  );
};
