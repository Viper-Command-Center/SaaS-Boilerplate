import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { FirstLoginForm } from '@/features/auth/FirstLoginForm';
import { getCurrentUser } from '@/libs/auth/session';

export const metadata: Metadata = {
  title: 'Choose your password',
  description: 'Replace the temporary password you were sent.',
};

export default async function ChangePasswordPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }
  // Nothing to do here once the temporary password has been replaced. Sending
  // them back to the dashboard also prevents a redirect loop with the layout.
  if (!user.mustChangePassword) {
    redirect('/dashboard');
  }

  return <FirstLoginForm email={user.email} />;
};

export const dynamic = 'force-dynamic';
