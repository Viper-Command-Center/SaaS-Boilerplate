import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { ResetPasswordForm } from '@/features/auth/ResetPasswordForm';

export const metadata: Metadata = {
  title: 'Reset password',
  description: 'Choose a new password for your Artivio account.',
};

export default async function ResetPasswordPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await props.params;
  const { token } = await props.searchParams;
  setRequestLocale(locale);

  return <ResetPasswordForm token={token ?? ''} />;
};
