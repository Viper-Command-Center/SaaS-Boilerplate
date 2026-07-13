import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { FileLibrary } from '@/features/files/FileLibrary';
import { getCurrentUser } from '@/libs/auth/session';
import { getUserTenants } from '@/libs/tenants';

export const metadata: Metadata = {
  title: 'Files',
  description: 'Documents the agent can read, and everything it has produced.',
};

export default async function FilesPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }

  const { t } = await props.searchParams;
  const tenants = await getUserTenants(user.id);
  const active = tenants.find(x => x.slug === t) ?? tenants[0];

  if (!active) {
    redirect('/dashboard');
  }

  const canWrite = user.isAdmin || ['owner', 'admin', 'editor'].includes(active.role);

  return (
    <>
      <TitleBar
        title="Files"
        description="Upload briefs and requirement docs and the agent will read them instead of asking you to paste them. Everything it generates is archived here too."
      />
      <FileLibrary tenantSlug={active.slug} canWrite={canWrite} />
    </>
  );
};

export const dynamic = 'force-dynamic';
