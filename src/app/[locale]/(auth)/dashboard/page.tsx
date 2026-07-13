import { setRequestLocale } from 'next-intl/server';
import { AgentChat } from '@/features/agent/AgentChat';
import { ApprovalsPanel } from '@/features/agent/ApprovalsPanel';
import { PanelsGrid } from '@/features/agent/PanelsGrid';
import { ToolsPanel } from '@/features/agent/ToolsPanel';
import { WorkspacePanel } from '@/features/agent/WorkspacePanel';
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

  if (!tenant) {
    return (
      <div className="
        rounded-2xl border bg-background p-10 text-center
      "
      >
        <h1 className="text-lg font-semibold">No workspace yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask your administrator to invite you to a workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {tenant.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {user?.firstName ? `Welcome back, ${user.firstName}. ` : ''}
            Your agent is standing by.
          </p>
        </div>
        <span className="
          rounded-full border px-2.5 py-1 text-xs font-medium
          text-muted-foreground
        "
        >
          {role}
        </span>
      </div>

      {/* Panels the agent built */}
      <PanelsGrid tenantSlug={tenant.slug} />

      {/* Agent + side rail */}
      <div className="
        grid gap-6
        lg:grid-cols-3
      "
      >
        <div className="lg:col-span-2">
          <AgentChat tenantSlug={tenant.slug} tenantName={tenant.name} />
        </div>
        <div className="space-y-6">
          {canApprove && <ApprovalsPanel tenantSlug={tenant.slug} />}
          {canManage && <ToolsPanel tenantSlug={tenant.slug} />}
        </div>
      </div>

      {canManage && (
        <WorkspacePanel
          tenantSlug={tenant.slug}
          canManageMembers={canManage}
          isPlatformAdmin={isPlatformAdmin}
        />
      )}
    </div>
  );
};
