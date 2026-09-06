import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { BookList } from '@/features/books/BookList';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getCurrentUser } from '@/libs/auth/session';
import { listBooks } from '@/libs/books/store';
import { getUserTenants } from '@/libs/tenants';

export const metadata: Metadata = {
  title: 'Books',
  description: 'Print books the agent is preparing for Amazon KDP.',
};

export default async function BooksPage(props: {
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

  const books = await listBooks(active.id);

  return (
    <>
      <TitleBar
        title="Books"
        description="Every book project in this workspace, with its KDP status and the files to upload. Ask the agent to add pages, build the cover, or package it for KDP."
      />
      <BookList
        tenantSlug={active.slug}
        books={books.map(b => ({
          id: b.id,
          title: b.title,
          subtitle: b.subtitle,
          author: b.author,
          kind: b.kind,
          trim: b.trim.label,
          bleed: b.bleed,
          paper: b.paper,
          ink: b.ink,
          singleSided: b.singleSided,
          logicalPages: b.pages.length,
          status: b.status,
          interiorFileId: b.interiorFileId,
          coverFileId: b.coverFileId,
          coverPreviewFileId: b.coverPreviewFileId,
          preflight: (b.lastPreflight ?? null) as { ok?: boolean; errors?: number; warnings?: number } | null,
          updatedAt: b.updatedAt.toISOString(),
        }))}
      />
    </>
  );
};

export const dynamic = 'force-dynamic';
