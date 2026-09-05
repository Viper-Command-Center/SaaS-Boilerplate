import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { EmployeePanel } from '@/features/agent/EmployeePanel';
import { MissionsPanel } from '@/features/agent/MissionsPanel';
import { ToolsPanel } from '@/features/agent/ToolsPanel';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { resolveAgentForTenant } from '@/libs/agent/persona';
import { getCurrentUser } from '@/libs/auth/session';
import { getUserTenants } from '@/libs/tenants';

export const metadata: Metadata = {
  title: 'Agent',
  description: 'Your AI employee, its tools and its missions.',
};

/**
 * The Agent page — full-width home for everything that used to be crammed
 * into the dashboard's right rail under the chat (Employee, Missions, Tools).
 *
 * Why it exists (2026-09-05): once the chat became sticky and viewport-bound,
 * the rail panels beneath it shared a ~40%-height scroll region. The Tools
 * panel alone is a catalog + connection list + inline edit forms; in that
 * region it was unusable — Ryan could not reach the WordPress connection's
 * Edit form at all. These panels are configuration and monitoring, not
 * conversation; they earn a page. Approvals stay on the dashboard next to the
 * chat, because approving a queued call is what lets the agent finish its
 * turn — it belongs where the turn is happening.
 *
 * Same `key={tenant.slug}` rule as the dashboard: every panel here fetches
 * `?tenant=<slug>` into client state, so switching workspace must remount them.
 */
export default async function AgentPage(props: {
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
  const tenant = tenants.find(x => x.slug === t) ?? tenants[0];
  if (!tenant) {
    redirect('/dashboard');
  }

  const isPlatformAdmin = user.isAdmin;
  const role = tenant.role ?? 'viewer';
  const canManage = isPlatformAdmin || role === 'owner' || role === 'admin';
  const canApprove = canManage || role === 'editor';
  const agent = await resolveAgentForTenant(tenant.id);

  return (
    <div key={tenant.slug}>
      <TitleBar
        title={`${agent.name} · ${tenant.name}`}
        description="Who your AI employee is, the tools it can reach, and the background missions it is running. Talk to it from the Workspace page."
      />

      {/*
        Tools is the panel that needs the width — a catalog, the connection
        list and inline forms. It gets two of three columns; Employee and
        Missions stack beside it. `min-w-0` for the usual grid reason: a long
        URL on a connection row must scroll inside its card, not push the
        layout sideways.
      */}
      <div className="
        grid items-start gap-6
        lg:grid-cols-3
      "
      >
        <div className="
          min-w-0 space-y-6
          lg:col-span-2
        "
        >
          {canManage
            ? <ToolsPanel tenantSlug={tenant.slug} />
            : (
                <div className="glass p-6 text-sm text-white/50">
                  Tools and connections are managed by workspace owners and admins.
                </div>
              )}
        </div>
        <div className="min-w-0 space-y-6">
          {canManage && <EmployeePanel tenantSlug={tenant.slug} />}
          <MissionsPanel tenantSlug={tenant.slug} canControl={canApprove} />
        </div>
      </div>
    </div>
  );
};

export const dynamic = 'force-dynamic';
