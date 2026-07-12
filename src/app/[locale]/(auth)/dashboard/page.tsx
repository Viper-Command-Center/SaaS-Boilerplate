import { setRequestLocale } from 'next-intl/server';
import { AgentChat } from '@/features/agent/AgentChat';
import { ApprovalsPanel } from '@/features/agent/ApprovalsPanel';
import { ToolsPanel } from '@/features/agent/ToolsPanel';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getCurrentUser } from '@/libs/auth/session';
import { ensureDefaultTenant } from '@/libs/tenants';

export default async function DashboardIndexPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  const tenants = user ? await ensureDefaultTenant(user.id, user.isAdmin) : [];
  const tenant = tenants[0];

  return (
    <>
      <TitleBar
        title={`Welcome${user?.firstName ? `, ${user.firstName}` : ''}`}
        description="Artivio Command Center — chat with your workspace agent below."
      />

      {tenant
        ? (
            <div className="space-y-6">
              <AgentChat tenantSlug={tenant.slug} tenantName={tenant.name} />
              <div className="grid gap-6 lg:grid-cols-2">
                <ToolsPanel tenantSlug={tenant.slug} />
                <ApprovalsPanel tenantSlug={tenant.slug} />
              </div>
            </div>
          )
        : (
            <div className="
              rounded-lg border bg-background p-6 text-sm
              text-muted-foreground
            "
            >
              <p>No workspace assigned to your account yet.</p>
            </div>
          )}
    </>
  );
};
