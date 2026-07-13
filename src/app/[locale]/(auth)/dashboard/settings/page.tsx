import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { AccountSettings } from '@/features/auth/AccountSettings';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getCurrentUser } from '@/libs/auth/session';

export const metadata: Metadata = {
  title: 'Account settings',
  description: 'Password and two-factor authentication.',
};

export default async function SettingsPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }

  return (
    <>
      <TitleBar
        title="Account settings"
        description={`Signed in as ${user.email}`}
      />
      <AccountSettings />
    </>
  );
};

export const dynamic = 'force-dynamic';
