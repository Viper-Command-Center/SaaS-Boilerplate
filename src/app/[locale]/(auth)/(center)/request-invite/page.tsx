import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { InviteRequestForm } from '@/features/auth/InviteRequestForm';

export const metadata: Metadata = {
  title: 'Request an invite',
  description: 'Tell us about your business and we\'ll set up your Artivio workspace.',
};

export default async function RequestInvitePage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return <InviteRequestForm />;
};
