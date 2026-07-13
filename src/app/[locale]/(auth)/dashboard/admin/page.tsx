import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { AdminConsole } from '@/features/admin/AdminConsole';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getCurrentUser } from '@/libs/auth/session';

export const metadata: Metadata = {
  title: 'Platform admin',
  description: 'Workspaces, users, usage and plugin catalog.',
};

export default async function AdminPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    redirect('/dashboard');
  }

  return (
    <>
      <TitleBar
        title="Platform admin"
        description="Every workspace, what it costs you, what it earns — plus users, caps and the plugin catalog."
      />
      <AdminConsole />
    </>
  );
};

export const dynamic = 'force-dynamic';
