import { setRequestLocale } from 'next-intl/server';
import { getCurrentUser } from '@/libs/auth/session';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardIndexPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();

  return (
    <>
      <TitleBar
        title={`Welcome${user?.firstName ? `, ${user.firstName}` : ''}`}
        description="Artivio Command Center — your agent workspace is coming online."
      />

      <div className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
        <p>
          Phase 0 complete: authentication and tenancy are live. Next up:
          the agent chat, per-tenant MCP registry, and the dynamic dashboard.
        </p>
      </div>
    </>
  );
};
