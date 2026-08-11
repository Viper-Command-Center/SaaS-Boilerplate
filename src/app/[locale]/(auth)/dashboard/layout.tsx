import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { Sidebar } from '@/features/shell/Sidebar';
import { getCurrentUser } from '@/libs/auth/session';
import { ensureDefaultTenant } from '@/libs/tenants';

export const metadata: Metadata = {
  title: 'Command Center',
  description: 'Your Artivio workspace.',
};

export default async function DashboardLayout(props: {
  params: Promise<{ locale: string }>;
  children: React.ReactNode;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }
  /**
   * 🔴 An admin-generated password is a plaintext string in someone's inbox.
   * This gate is on the SERVER and covers the whole dashboard, so it cannot be
   * skipped by navigating straight to a URL — the sign-in form used to receive
   * `mustChangePassword` from the login response and simply discard it.
   */
  if (user.mustChangePassword) {
    redirect('/change-password');
  }

  const tenants = await ensureDefaultTenant(user.id, user.isAdmin);

  return (
    <div className="
      artivio artivio-canvas flex min-h-svh flex-col
      lg:flex-row
    "
    >
      <Suspense fallback={null}>
        <Sidebar
          workspaces={tenants.map(t => ({ id: t.id, name: t.name, slug: t.slug, role: t.role }))}
          isAdmin={user.isAdmin}
          userEmail={user.email}
          userName={user.firstName}
        />
      </Suspense>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-5 py-8">
          {props.children}
        </div>
      </main>
    </div>
  );
}

export const dynamic = 'force-dynamic';
