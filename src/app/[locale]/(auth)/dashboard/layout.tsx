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

  // Authoritative auth check (the edge middleware only verifies the JWT
  // signature; this hits the DB and honors revocation/expiry).
  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }

  const tenants = await ensureDefaultTenant(user.id, user.isAdmin);

  return (
    <div className="
      flex min-h-svh flex-col bg-muted/40
      lg:flex-row
    "
    >
      <Suspense fallback={null}>
        <Sidebar
          workspaces={tenants.map(t => ({ id: t.id, name: t.name, slug: t.slug, role: t.role }))}
          isAdmin={user.isAdmin}
          userEmail={user.email}
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
