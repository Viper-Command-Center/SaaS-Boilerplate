import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { AgentChat } from '@/features/agent/AgentChat';
import { ApprovalsPanel } from '@/features/agent/ApprovalsPanel';
import { ChatJumpButton } from '@/features/agent/ChatJumpButton';

import { PanelsGrid } from '@/features/agent/PanelsGrid';
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

      {/*
        Dashboard content and chat share one grid so that CHAT CAN STAY ON
        SCREEN while the panels scroll past it.

        Chat used to sit BELOW PanelsGrid, and the grid grows without bound as
        the agent adds panels and views — so the better a workspace's dashboard
        got, the further its chat box was pushed off the bottom of the page. The
        thing you talk to should not become progressively harder to reach the
        more you use the product.

        🔴 `lg:items-start` IS LOAD-BEARING, not cosmetic. Grid items stretch to
        the row height by default, which makes a sticky child exactly as tall as
        its container and therefore gives it nothing to scroll within — sticky
        then silently does nothing at all. `items-start` lets the short column
        stay short so the tall one can scroll past it.

        `min-w-0` on the wide column is the other classic grid trap: without it
        a wide panel (a table, a long URL) refuses to shrink and blows the whole
        layout out sideways instead of scrolling inside its own card.
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
          {/* Panels the agent built — draggable for editors and up */}
          <PanelsGrid tenantSlug={tenant.slug} canEdit={canApprove} />

          {canManage && (
            <WorkspacePanel
              tenantSlug={tenant.slug}
              canManageMembers={canManage}
              isPlatformAdmin={isPlatformAdmin}
            />
          )}
        </div>

        {/*
          🔴 THE WHOLE RAIL IS STICKY AND VIEWPORT-BOUNDED (2026-09-05).

          Previously only the chat was sticky and the Employee / Missions /
          Approvals / Tools cards scrolled beneath it as normal siblings. That
          fails on any dashboard taller than one screen: the later siblings
          paint OVER the sticky chat as they scroll up (the glass card is
          translucent, so they show straight through it), and the user has to
          scroll back to the top to talk to the agent — the exact complaint the
          sticky was meant to fix. The reason the rail was not made sticky was
          the trap noted below: a sticky element taller than the viewport has
          its bottom cut off. The fix is not "don't stick the rail", it is
          "bound the rail to the viewport and scroll INSIDE it":

            rail  = sticky, exactly viewport-high (100vh − top − bottom margin),
                    a flex column, overflow hidden so it can never exceed that;
            chat  = flex-1 with a floor, so it takes all the height not needed
                    by the approvals region below;
            rest  = shrinkable, min-h-0 + overflow-y-auto — Approvals plus a
                    link to /dashboard/agent, where Employee / Missions / Tools
                    now live full-width (they were unusable squeezed in here).

          `min-h-0` on both flex children is load-bearing: a flex item's default
          min-height is `auto` (= its content), which would let the rest-region
          push the rail past the viewport again and silently defeat the bound.
          Below `lg` none of this applies (single column, ChatJumpButton).
        */}
        <div className="
          min-w-0 space-y-6
          lg:sticky lg:top-6 lg:flex lg:h-[calc(100vh-3rem)] lg:flex-col
          lg:gap-6 lg:space-y-0 lg:overflow-hidden
        "
        >
          <div
            id="agent-chat"
            className="lg:flex lg:min-h-[360px] lg:flex-1 lg:flex-col"
          >
            <AgentChat
              tenantSlug={tenant.slug}
              tenantName={tenant.name}
              agentName={agent.name}
              agentAvatarUrl={agent.avatarUrl}
              agentAccent={agent.accent}
              canSend={canApprove}
            />
          </div>

          {/*
            Only APPROVALS live under the chat now. Approving a queued call is
            what lets the agent finish its turn, so it belongs beside the
            conversation. Employee, Missions and Tools moved to /dashboard/agent
            (2026-09-05): in this ~40%-height region the Tools panel was
            unusable — the WordPress connection's Edit form could not be
            reached at all. The link card is the way there.
          */}
          <div className="
            space-y-6
            lg:min-h-0 lg:shrink lg:overflow-y-auto lg:pr-1
          "
          >
            {canApprove && <ApprovalsPanel tenantSlug={tenant.slug} />}
            <Link
              href={`/dashboard/agent?t=${tenant.slug}`}
              className="
                glass flex items-center justify-between gap-3 px-4 py-3 text-sm
                text-white/70 transition
                hover:text-white
              "
            >
              <span>{`Manage ${agent.name} — tools, missions, persona`}</span>
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </div>

      {/*
        Mobile only. Sticky does nothing in a single column, so below `lg` the
        chat is still rendered after the dashboard — which is exactly where the
        original complaint came from. Renders nothing while chat is on screen.

        Inside the keyed subtree deliberately: it unmounts on workspace switch
        like everything else here.
      */}
      <ChatJumpButton targetId="agent-chat" agentName={agent.name} />
    </div>
  );
};
