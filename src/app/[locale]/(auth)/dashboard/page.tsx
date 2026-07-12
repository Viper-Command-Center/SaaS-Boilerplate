import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AgentChat } from '@/features/agent/AgentChat';
import { ApprovalsPanel } from '@/features/agent/ApprovalsPanel';
import { PanelsGrid } from '@/features/agent/PanelsGrid';
import { ToolsPanel } from '@/features/agent/ToolsPanel';
import { WorkspacePanel } from '@/features/agent/WorkspacePanel';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getCurrentUser } from '@/libs/auth/session';
import { ensureDefaultTenant } from '@/libs/tenants';

export default async function DashboardIndexPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { locale } = await props.params;
  const { t } = await props.searchParams;
  setRequestLocale(locale);

  const user = await getCurrentUser();
  const tenants = user ? await ensureDefaultTenant(user.id, user.isAdmin) : [];
  const tenant = tenants.find(x => x.slug === t) ?? tenants[0];

  const isPlatformAdmin = user?.isAdmin ?? false;
  const role = tenant?.role ?? 'viewer';
  const canManage = isPlatformAdmin || role === 'owner' || role === 'admin';
  const canApprove = canManage || role === 'editor';

  return (
    <>
      <TitleBar
        title={`Welcome${user?.firstName ? `, ${user.firstName}` : ''}`}
        description={tenant ? `Workspace: ${tenant.name}` : 'Artivio Command Center'}
      />

      {tenants.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {tenants.map(x => (
            <Link
              key={x.id}
              href={`/dashboard?t=${encodeURIComponent(x.slug)}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                x.id === tenant?.id
                  ? 'bg-primary text-primary-foreground'
                  : `
                    bg-background text-muted-foreground
                    hover:text-foreground
                  `
              }`}
            >
              {x.name}
            </Link>
          ))}
        </div>
      )}

      {tenant
        ? (
            <div className="space-y-6">
              <PanelsGrid tenantSlug={tenant.slug} />
              <AgentChat tenantSlug={tenant.slug} tenantName={tenant.name} />
              <div className="grid gap-6 lg:grid-cols-2">
                {canManage && <ToolsPanel tenantSlug={tenant.slug} />}
                {canApprove && <ApprovalsPanel tenantSlug={tenant.slug} />}
              </div>
              <WorkspacePanel
                tenantSlug={tenant.slug}
                canManageMembers={canManage}
                isPlatformAdmin={isPlatformAdmin}
              />
            </div>
          )
        : (
            <div className="
              rounded-lg border bg-background p-6 text-sm
              text-muted-foreground
            "
            >
              <p>No workspace assigned to your account yet. Ask your administrator for an invite.</p>
            </div>
          )}
    </>
  );
};
