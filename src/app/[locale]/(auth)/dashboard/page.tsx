import { setRequestLocale } from 'next-intl/server';
import { AgentChat } from '@/features/agent/AgentChat';
import { ApprovalsPanel } from '@/features/agent/ApprovalsPanel';
import { EmployeePanel } from '@/features/agent/EmployeePanel';
import { MissionsPanel } from '@/features/agent/MissionsPanel';

import { PanelsGrid } from '@/features/agent/PanelsGrid';
import { ToolsPanel } from '@/features/agent/ToolsPanel';
import { WorkspacePanel } from '@/features/agent/WorkspacePanel';
import { resolveAgentForTenant } from '@/libs/agent/persona';
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
      <div className="glass p-10 text-center">
        <h1 className="text-lg font-semibold text-white">No workspace yet</h1>
        <p className="mt-2 text-sm text-white/50">
          Ask your administrator to invite you to a workspace.
        </p>
      </div>
    );
  }

  const agent = await resolveAgentForTenant(tenant.id);

  return (
    /**
     * 🔴 `key={tenant.slug}` IS THE TENANT-ISOLATION BOUNDARY FOR CLIENT STATE.
     * Do not remove it, and do not "simplify" it away.
     *
     * Every panel below is a client component that fetches `?tenant=<slug>` and
     * holds the result in React state. The SERVER is scoped correctly — every
     * one of those endpoints checks workspace membership and filters by
     * tenantId, so no data crosses a tenant boundary. But without this key,
     * switching workspace re-renders the SAME component instances with a new
     * prop, so each one keeps showing the previous workspace's data until its
     * own refetch resolves — and keeps showing it FOREVER if that refetch fails.
     *
     * That is how one agency owner saw True Therapy's mission plan sitting under
     * a "Max · BudgetSmart AI" header. Nothing leaked. It did not matter: on a
     * screen share with a client, a stale transcript under another client's name
     * is indistinguishable from a breach, and no explanation afterwards undoes
     * what they saw.
     *
     * Changing the key forces React to unmount and remount the whole subtree, so
     * every panel starts from empty state. That fixes it once, for every panel
     * here and every panel added later — rather than relying on each new
     * component remembering to clear itself, which six of the seven did not.
     */
    <div key={tenant.slug} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="
            text-[11px] font-semibold tracking-[0.14em] text-white/35 uppercase
          "
          >
            Command Center
          </p>
          <h1 className="grad-text mt-1 text-3xl font-extrabold tracking-tight">
            {tenant.name}
          </h1>
          <p className="mt-1 text-sm text-white/45">
            {user?.firstName ? `Welcome back, ${user.firstName}. ` : ''}
            {agent.persona ? `${agent.name} is standing by.` : 'Your agent is standing by.'}
          </p>
        </div>
        <span className="
          rounded-full border border-white/12 bg-white/5 px-3 py-1 text-[11px]
          font-medium tracking-wide text-white/60
        "
        >
          {role}
        </span>
      </div>

      {/* Panels the agent built — draggable for editors and up */}
      <PanelsGrid tenantSlug={tenant.slug} canEdit={canApprove} />

      {/* Agent + side rail */}
      <div className="
        grid gap-6
        lg:grid-cols-3
      "
      >
        <div className="lg:col-span-2">
          <AgentChat
            tenantSlug={tenant.slug}
            tenantName={tenant.name}
            agentName={agent.name}
            agentAvatarUrl={agent.avatarUrl}
            agentAccent={agent.accent}
          />
        </div>
        <div className="space-y-6">
          {canManage && <EmployeePanel tenantSlug={tenant.slug} />}
          <MissionsPanel tenantSlug={tenant.slug} canControl={canApprove} />
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
