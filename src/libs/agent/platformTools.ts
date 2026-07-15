/**
 * Platform tools — always available to the agent in every workspace, policy
 * 'auto' (they only touch the tenant's own dashboard/data, never the outside
 * world). This is how the agent reshapes the dashboard on request:
 * "show me weekly Shopify revenue" → write_dataset + create_panel.
 */

import type { AnthropicTool } from '@/libs/mcp/registry';
import { and, asc, desc, eq } from 'drizzle-orm';
import { assertPublicUrl, buildWebTools } from '@/libs/agent/webTools';
import { captureIssue } from '@/libs/support/issues';
import { db } from '@/libs/DB';
import { getFile, listFiles, saveFile, saveRemoteFile } from '@/libs/storage/files';
import { dashboardPanels, dashboardViews, datasets, scheduledTasks } from '@/models/Schema';

export type PlatformExecutor = {
  policy: 'auto';
  call: (args: Record<string, unknown>) => Promise<string>;
};

const PANEL_TYPES = ['kpi', 'timeseries', 'table', 'markdown'];

/**
 * Sane width by type, so a dashboard is readable WITHOUT anyone tidying it
 * afterwards. A 4-column table in 1/3 of the screen is the single biggest
 * source of visual mess; a lone KPI number does not need more than 1.
 */
const DEFAULT_WIDTH: Record<string, number> = {
  kpi: 1,
  timeseries: 2,
  table: 3,
  markdown: 2,
};

const clampWidth = (w: unknown, type: string): number => {
  if (typeof w !== 'number' || !Number.isFinite(w)) {
    return DEFAULT_WIDTH[type] ?? 1;
  }
  return Math.min(3, Math.max(1, Math.round(w)));
};

/** Resolve a view by id or by name (agents reason in names, not uuids). */
async function resolveViewId(tenantId: string, ref: unknown): Promise<string | null> {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) {
    return null;
  }
  const rows = await db
    .select({ id: dashboardViews.id, name: dashboardViews.name })
    .from(dashboardViews)
    .where(eq(dashboardViews.tenantId, tenantId));
  const byId = rows.find(v => v.id === value);
  if (byId) {
    return byId.id;
  }
  const byName = rows.find(v => v.name.toLowerCase() === value.toLowerCase());
  if (!byName) {
    throw new Error(
      `No dashboard tab called "${value}". Existing tabs: ${rows.map(v => v.name).join(', ') || 'none yet'}. Create it with create_view first.`,
    );
  }
  return byName.id;
}

export function buildPlatformTools(tenantId: string): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const executors = new Map<string, PlatformExecutor>();

  const anthropicTools: AnthropicTool[] = [
    {
      name: 'list_views',
      description: 'List the dashboard tabs (views) in this workspace with their ids, names and how many panels each holds. Call this before creating panels so related panels land on the same tab instead of piling onto one page.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'create_view',
      description: 'Create a dashboard tab. Tabs are the top-level organiser — group panels by domain (e.g. Analytics, Social, Content, Ops) so the dashboard stays readable as more tools are connected.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short tab label, e.g. Analytics' },
          icon: { type: 'string', description: 'Optional single emoji for the tab, e.g. 📊' },
          position: { type: 'number', description: 'Left-to-right order. Lower is further left.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_view',
      description: 'Rename a dashboard tab, change its icon, or reorder it.',
      input_schema: {
        type: 'object',
        properties: {
          viewId: { type: 'string', description: 'Tab id or exact current name.' },
          name: { type: 'string' },
          icon: { type: 'string' },
          position: { type: 'number' },
        },
        required: ['viewId'],
      },
    },
    {
      name: 'delete_view',
      description: 'Delete a dashboard tab. Its panels are NOT deleted — they become unfiled and appear on the first tab. Move them first if they belong somewhere specific.',
      input_schema: {
        type: 'object',
        properties: { viewId: { type: 'string', description: 'Tab id or exact name.' } },
        required: ['viewId'],
      },
    },
    {
      name: 'list_panels',
      description: 'List the dashboard panels in this workspace with their ids, types, configs, and layout (which tab, which section, width, position). Optionally filter to one tab.',
      input_schema: {
        type: 'object',
        properties: { viewId: { type: 'string', description: 'Optional tab id or name to filter by.' } },
      },
    },
    {
      name: 'create_panel',
      description: 'Create a dashboard panel. Types: kpi (config: datasetKey, valueField, label?), timeseries (config: datasetKey, valueField), table (config: datasetKey, columns?: string[], limit?: number), markdown (config: text). Put it on a tab with viewId and group it with section. Do NOT create a markdown panel purely to act as a section heading — use the section field, which renders a real collapsible header.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: PANEL_TYPES },
          title: { type: 'string' },
          config: { type: 'object' },
          viewId: { type: 'string', description: 'Tab id or name. Defaults to the first tab.' },
          section: { type: 'string', description: 'Optional collapsible group label within the tab, e.g. "Traffic".' },
          width: { type: 'number', description: 'Grid columns 1-3. Omit for a sensible default (kpi 1, timeseries 2, markdown 2, table 3).' },
          position: { type: 'number' },
        },
        required: ['type', 'title', 'config'],
      },
    },
    {
      name: 'update_panel',
      description: 'Update an existing dashboard panel by id: title, config, or layout (viewId, section, width, position).',
      input_schema: {
        type: 'object',
        properties: {
          panelId: { type: 'string' },
          title: { type: 'string' },
          config: { type: 'object' },
          viewId: { type: 'string', description: 'Tab id or name to move it to.' },
          section: { type: 'string', description: 'Group label. Pass an empty string to ungroup.' },
          width: { type: 'number', description: 'Grid columns 1-3.' },
          position: { type: 'number' },
        },
        required: ['panelId'],
      },
    },
    {
      name: 'move_panels',
      description: 'Reorganise MANY panels at once — the efficient way to answer "tidy up my dashboard". Give each panel its target tab, section, width and position in one call rather than calling update_panel repeatedly.',
      input_schema: {
        type: 'object',
        properties: {
          moves: {
            type: 'array',
            description: 'One entry per panel to move.',
            items: {
              type: 'object',
              properties: {
                panelId: { type: 'string' },
                viewId: { type: 'string', description: 'Tab id or name.' },
                section: { type: 'string' },
                width: { type: 'number' },
                position: { type: 'number' },
              },
              required: ['panelId'],
            },
          },
        },
        required: ['moves'],
      },
    },
    {
      name: 'delete_panel',
      description: 'Delete a dashboard panel by id.',
      input_schema: {
        type: 'object',
        properties: { panelId: { type: 'string' } },
        required: ['panelId'],
      },
    },
    {
      name: 'write_dataset',
      description: 'Append rows to a workspace dataset (creates the dataset key implicitly). Each row is a flat JSON object. Datasets feed kpi/timeseries/table panels.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Dataset key, e.g. organic_traffic' },
          rows: { type: 'array', items: { type: 'object' } },
        },
        required: ['key', 'rows'],
      },
    },
    {
      name: 'list_scheduled_tasks',
      description: 'List this workspace\'s scheduled agent tasks (standing missions run automatically on an interval), including last results.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'create_scheduled_task',
      description: 'Create a standing mission that runs automatically on an interval (min 15 minutes). Write the prompt as complete instructions to your future self — each run starts fresh with this prompt plus all workspace tools. Use for recurring work: "publish an SEO blog post every Monday", "collect analytics nightly", "work toward the customer goal every 4 hours and report progress to the goal_progress dataset".',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string', description: 'Full self-contained instructions for each run' },
          intervalMinutes: { type: 'number', description: 'Minutes between runs (min 15, default 1440 = daily)' },
        },
        required: ['name', 'prompt'],
      },
    },
    {
      name: 'update_scheduled_task',
      description: 'Update a scheduled task (name, prompt, intervalMinutes, enabled).',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          name: { type: 'string' },
          prompt: { type: 'string' },
          intervalMinutes: { type: 'number' },
          enabled: { type: 'boolean' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'delete_scheduled_task',
      description: 'Delete a scheduled task by id.',
      input_schema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
    },
    {
      name: 'query_dataset',
      description: 'Read the most recent rows of a workspace dataset (newest first).',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['key'],
      },
    },
    {
      name: 'list_files',
      description: 'List this workspace\'s file library: documents the client uploaded (briefs, brand guides, requirement lists) and media you generated. ALWAYS check this before starting a substantial piece of work — the instructions you need are often already here rather than in the chat.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Filter: knowledge | asset | note' },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read the text of a file in the library by id (from list_files). Use this for uploaded briefs and requirement docs instead of asking the user to paste them. Binary files (images, video) have no text — use their URL instead.',
      input_schema: {
        type: 'object',
        properties: { fileId: { type: 'string' } },
        required: ['fileId'],
      },
    },
    {
      name: 'save_note',
      description: 'Save a text document into the workspace library (a plan, a draft, research notes, a generated report) so it persists across conversations and the client can open it.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename, e.g. "wordpress-migration-plan.md"' },
          content: { type: 'string' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'save_file_from_url',
      description: 'Download a file from a public URL and save the ACTUAL FILE into the workspace library (R2) — images, PNGs, PDFs, video, CSVs, anything. Use this whenever you produce or find a binary asset the user should keep: a QR code, a chart, an export, a rendered image. save_note only stores text — it CANNOT store an image. The saved file gets a permanent public URL you can use in posts and on sites. Do not tell the user you cannot save binary files; use this.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public http(s) URL of the file to fetch.' },
          name: { type: 'string', description: 'Filename to save it as, with extension, e.g. "budgetsmart-qr-emerald.png".' },
        },
        required: ['url', 'name'],
      },
    },
    {
      name: 'report_issue',
      description: 'Escalate a problem to the Artivio operator (a human engineer). Use this when something is broken in a way the USER CANNOT FIX — a tool that should work but errors unexpectedly, a platform feature behaving wrongly, or repeated failures with no clear cause. Do NOT use it for things the user can fix themselves (wrong API key, missing credential, a capability we simply do not have). Tool failures are already reported automatically — use this for problems YOU notice that no exception captured. Tell the user you have escalated it.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One line: what is broken.' },
          detail: { type: 'string', description: 'What you tried, what happened, exact error text you saw, and what you expected.' },
        },
        required: ['summary', 'detail'],
      },
    },
  ];

  /** The tab a panel lands on when none is named: the leftmost, created on demand. */
  const defaultViewId = async (): Promise<string | null> => {
    const [first] = await db
      .select({ id: dashboardViews.id })
      .from(dashboardViews)
      .where(eq(dashboardViews.tenantId, tenantId))
      .orderBy(asc(dashboardViews.position), asc(dashboardViews.createdAt))
      .limit(1);
    if (first) {
      return first.id;
    }
    const [created] = await db
      .insert(dashboardViews)
      .values({ tenantId, name: 'Overview', icon: '🏠', position: 0 })
      .returning({ id: dashboardViews.id });
    return created?.id ?? null;
  };

  executors.set('list_views', {
    policy: 'auto',
    call: async () => {
      const views = await db
        .select()
        .from(dashboardViews)
        .where(eq(dashboardViews.tenantId, tenantId))
        .orderBy(asc(dashboardViews.position));
      const panels = await db
        .select({ viewId: dashboardPanels.viewId })
        .from(dashboardPanels)
        .where(eq(dashboardPanels.tenantId, tenantId));
      return JSON.stringify(
        views.map(v => ({
          id: v.id,
          name: v.name,
          icon: v.icon,
          position: v.position,
          panelCount: panels.filter(p => p.viewId === v.id).length,
        })),
      );
    },
  });

  executors.set('create_view', {
    policy: 'auto',
    call: async (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) {
        throw new Error('A tab needs a name.');
      }
      const existing = await db
        .select({ id: dashboardViews.id, name: dashboardViews.name })
        .from(dashboardViews)
        .where(eq(dashboardViews.tenantId, tenantId));
      const dupe = existing.find(v => v.name.toLowerCase() === name.toLowerCase());
      if (dupe) {
        return `A tab called "${name}" already exists (id ${dupe.id}) — use that one instead of creating a duplicate.`;
      }
      const [row] = await db
        .insert(dashboardViews)
        .values({
          tenantId,
          name: name.slice(0, 60),
          icon: args.icon ? String(args.icon).slice(0, 8) : null,
          position: typeof args.position === 'number' ? args.position : existing.length,
        })
        .returning({ id: dashboardViews.id });
      return `Tab "${name}" created (id ${row?.id}). Put panels on it with create_panel viewId, or move existing ones with move_panels.`;
    },
  });

  executors.set('update_view', {
    policy: 'auto',
    call: async (args) => {
      const viewId = await resolveViewId(tenantId, args.viewId);
      if (!viewId) {
        throw new Error('Which tab? Pass viewId (id or exact name).');
      }
      await db
        .update(dashboardViews)
        .set({
          ...(args.name !== undefined ? { name: String(args.name).slice(0, 60) } : {}),
          ...(args.icon !== undefined ? { icon: String(args.icon).slice(0, 8) } : {}),
          ...(typeof args.position === 'number' ? { position: args.position } : {}),
        })
        .where(and(eq(dashboardViews.id, viewId), eq(dashboardViews.tenantId, tenantId)));
      return 'Tab updated.';
    },
  });

  executors.set('delete_view', {
    policy: 'auto',
    call: async (args) => {
      const viewId = await resolveViewId(tenantId, args.viewId);
      if (!viewId) {
        throw new Error('Which tab? Pass viewId (id or exact name).');
      }
      // Panels survive (FK is ON DELETE set null) and resurface on the first
      // tab — losing a tab must never silently lose the client's panels.
      const orphaned = await db
        .select({ id: dashboardPanels.id })
        .from(dashboardPanels)
        .where(and(eq(dashboardPanels.viewId, viewId), eq(dashboardPanels.tenantId, tenantId)));
      const result = await db
        .delete(dashboardViews)
        .where(and(eq(dashboardViews.id, viewId), eq(dashboardViews.tenantId, tenantId)))
        .returning({ id: dashboardViews.id });
      if (result.length === 0) {
        throw new Error('Tab not found in this workspace.');
      }
      return orphaned.length > 0
        ? `Tab deleted. Its ${orphaned.length} panel(s) were not deleted — they are now unfiled and show on the first tab.`
        : 'Tab deleted.';
    },
  });

  executors.set('list_panels', {
    policy: 'auto',
    call: async (args) => {
      const filterView = args.viewId ? await resolveViewId(tenantId, args.viewId) : null;
      const rows = await db
        .select()
        .from(dashboardPanels)
        .where(
          filterView
            ? and(eq(dashboardPanels.tenantId, tenantId), eq(dashboardPanels.viewId, filterView))
            : eq(dashboardPanels.tenantId, tenantId),
        )
        .orderBy(asc(dashboardPanels.position));
      const views = await db
        .select({ id: dashboardViews.id, name: dashboardViews.name })
        .from(dashboardViews)
        .where(eq(dashboardViews.tenantId, tenantId));
      return JSON.stringify(
        rows.map(r => ({
          id: r.id,
          type: r.type,
          title: r.title,
          config: r.config,
          view: views.find(v => v.id === r.viewId)?.name ?? null,
          viewId: r.viewId,
          section: r.section,
          width: r.width,
          position: r.position,
        })),
      );
    },
  });

  executors.set('create_panel', {
    policy: 'auto',
    call: async (args) => {
      const type = String(args.type ?? '');
      if (!PANEL_TYPES.includes(type)) {
        throw new Error(`Invalid panel type. Use one of: ${PANEL_TYPES.join(', ')}`);
      }
      const viewId = args.viewId ? await resolveViewId(tenantId, args.viewId) : await defaultViewId();
      const [row] = await db
        .insert(dashboardPanels)
        .values({
          tenantId,
          viewId,
          type,
          title: String(args.title ?? 'Untitled'),
          config: args.config ?? {},
          section: args.section ? String(args.section).slice(0, 60) : null,
          width: clampWidth(args.width, type),
          position: typeof args.position === 'number' ? args.position : 0,
        })
        .returning({ id: dashboardPanels.id });
      return `Panel created (id ${row?.id}). It is now visible on the dashboard.`;
    },
  });

  executors.set('update_panel', {
    policy: 'auto',
    call: async (args) => {
      const panelId = String(args.panelId ?? '');
      const [current] = await db
        .select({ type: dashboardPanels.type })
        .from(dashboardPanels)
        .where(and(eq(dashboardPanels.id, panelId), eq(dashboardPanels.tenantId, tenantId)))
        .limit(1);
      if (!current) {
        throw new Error('Panel not found in this workspace.');
      }
      const viewId = args.viewId !== undefined ? await resolveViewId(tenantId, args.viewId) : undefined;
      await db
        .update(dashboardPanels)
        .set({
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(args.config !== undefined ? { config: args.config } : {}),
          ...(viewId !== undefined ? { viewId } : {}),
          // Empty string is a deliberate "ungroup", not a no-op.
          ...(args.section !== undefined ? { section: String(args.section).slice(0, 60) || null } : {}),
          ...(args.width !== undefined ? { width: clampWidth(args.width, current.type) } : {}),
          ...(typeof args.position === 'number' ? { position: args.position } : {}),
        })
        .where(and(eq(dashboardPanels.id, panelId), eq(dashboardPanels.tenantId, tenantId)));
      return 'Panel updated.';
    },
  });

  executors.set('move_panels', {
    policy: 'auto',
    call: async (args) => {
      const moves = Array.isArray(args.moves) ? args.moves : [];
      if (moves.length === 0) {
        throw new Error('No moves given.');
      }
      // Resolve tab names once — a reorganise usually targets a handful of tabs.
      const viewCache = new Map<string, string | null>();
      let moved = 0;
      const problems: string[] = [];

      for (const raw of moves) {
        const m = raw as Record<string, unknown>;
        const panelId = String(m.panelId ?? '');
        try {
          const [current] = await db
            .select({ type: dashboardPanels.type })
            .from(dashboardPanels)
            .where(and(eq(dashboardPanels.id, panelId), eq(dashboardPanels.tenantId, tenantId)))
            .limit(1);
          if (!current) {
            problems.push(`${panelId}: not found in this workspace`);
            continue;
          }
          let viewId: string | null | undefined;
          if (m.viewId !== undefined) {
            const key = String(m.viewId);
            if (!viewCache.has(key)) {
              viewCache.set(key, await resolveViewId(tenantId, key));
            }
            viewId = viewCache.get(key) ?? null;
          }
          await db
            .update(dashboardPanels)
            .set({
              ...(viewId !== undefined ? { viewId } : {}),
              ...(m.section !== undefined ? { section: String(m.section).slice(0, 60) || null } : {}),
              ...(m.width !== undefined ? { width: clampWidth(m.width, current.type) } : {}),
              ...(typeof m.position === 'number' ? { position: m.position } : {}),
            })
            .where(and(eq(dashboardPanels.id, panelId), eq(dashboardPanels.tenantId, tenantId)));
          moved += 1;
        } catch (err) {
          problems.push(`${panelId}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      }

      // Report partial failure honestly rather than claiming a clean tidy-up.
      return problems.length > 0
        ? `Moved ${moved} of ${moves.length} panels. Problems: ${problems.join('; ')}`
        : `Moved ${moved} panel(s). The dashboard updates within 30 seconds.`;
    },
  });

  executors.set('delete_panel', {
    policy: 'auto',
    call: async (args) => {
      const panelId = String(args.panelId ?? '');
      const result = await db
        .delete(dashboardPanels)
        .where(and(eq(dashboardPanels.id, panelId), eq(dashboardPanels.tenantId, tenantId)))
        .returning({ id: dashboardPanels.id });
      if (result.length === 0) {
        throw new Error('Panel not found in this workspace.');
      }
      return 'Panel deleted.';
    },
  });

  executors.set('write_dataset', {
    policy: 'auto',
    call: async (args) => {
      const key = String(args.key ?? '').slice(0, 80);
      const rows = Array.isArray(args.rows) ? args.rows : [];
      if (!key || rows.length === 0) {
        throw new Error('Provide a dataset key and at least one row.');
      }
      if (rows.length > 500) {
        throw new Error('Max 500 rows per write.');
      }
      await db.insert(datasets).values(rows.map(row => ({ tenantId, key, row })));
      return `Wrote ${rows.length} row(s) to dataset "${key}".`;
    },
  });

  executors.set('list_scheduled_tasks', {
    policy: 'auto',
    call: async () => {
      const rows = await db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.tenantId, tenantId))
        .orderBy(asc(scheduledTasks.createdAt));
      return JSON.stringify(rows.map(r => ({
        id: r.id,
        name: r.name,
        intervalMinutes: r.intervalMinutes,
        enabled: r.enabled,
        nextRunAt: r.nextRunAt,
        lastRunAt: r.lastRunAt,
        lastResult: (r.lastResult ?? '').slice(0, 300),
      })));
    },
  });

  executors.set('create_scheduled_task', {
    policy: 'auto',
    call: async (args) => {
      const name = String(args.name ?? '').slice(0, 200);
      const prompt = String(args.prompt ?? '');
      const intervalMinutes = Math.min(Math.max(Number(args.intervalMinutes) || 1440, 15), 60 * 24 * 30);
      if (!name || !prompt) {
        throw new Error('Provide name and prompt.');
      }
      const existing = await db.select({ id: scheduledTasks.id }).from(scheduledTasks).where(eq(scheduledTasks.tenantId, tenantId));
      if (existing.length >= 20) {
        throw new Error('Limit of 20 scheduled tasks per workspace.');
      }
      const [row] = await db
        .insert(scheduledTasks)
        .values({ tenantId, name, prompt, intervalMinutes })
        .returning({ id: scheduledTasks.id });
      return `Scheduled task "${name}" created (id ${row?.id}), runs every ${intervalMinutes} minutes starting at the next cron tick. Its runs go through the same approvals gateway as chat.`;
    },
  });

  executors.set('update_scheduled_task', {
    policy: 'auto',
    call: async (args) => {
      const taskId = String(args.taskId ?? '');
      const result = await db
        .update(scheduledTasks)
        .set({
          ...(args.name !== undefined ? { name: String(args.name).slice(0, 200) } : {}),
          ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
          ...(args.intervalMinutes !== undefined
            ? { intervalMinutes: Math.min(Math.max(Number(args.intervalMinutes) || 1440, 15), 60 * 24 * 30) }
            : {}),
          ...(args.enabled !== undefined ? { enabled: Boolean(args.enabled) } : {}),
        })
        .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.tenantId, tenantId)))
        .returning({ id: scheduledTasks.id });
      if (result.length === 0) {
        throw new Error('Task not found in this workspace.');
      }
      return 'Scheduled task updated.';
    },
  });

  executors.set('delete_scheduled_task', {
    policy: 'auto',
    call: async (args) => {
      const taskId = String(args.taskId ?? '');
      const result = await db
        .delete(scheduledTasks)
        .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.tenantId, tenantId)))
        .returning({ id: scheduledTasks.id });
      if (result.length === 0) {
        throw new Error('Task not found in this workspace.');
      }
      return 'Scheduled task deleted.';
    },
  });

  executors.set('query_dataset', {
    policy: 'auto',
    call: async (args) => {
      const key = String(args.key ?? '');
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const rows = await db
        .select({ row: datasets.row, capturedAt: datasets.capturedAt })
        .from(datasets)
        .where(and(eq(datasets.tenantId, tenantId), eq(datasets.key, key)))
        .orderBy(desc(datasets.capturedAt))
        .limit(limit);
      return JSON.stringify(rows).slice(0, 20_000);
    },
  });

  // ── File library ───────────────────────────────────────────────────────────
  executors.set('list_files', {
    policy: 'auto',
    call: async (args) => {
      const rows = await listFiles(tenantId, 200);
      const kind = args.kind ? String(args.kind) : null;
      const filtered = kind ? rows.filter(r => r.kind === kind) : rows;
      if (filtered.length === 0) {
        return 'The workspace file library is empty. The client can upload briefs and documents on the Files page.';
      }
      return JSON.stringify(filtered.map(f => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        mime: f.mime,
        sizeKb: Math.round(f.sizeBytes / 1024),
        readable: Boolean(f.hasText),
        url: f.publicUrl,
        source: f.source,
        createdAt: f.createdAt,
      }))).slice(0, 20_000);
    },
  });

  executors.set('read_file', {
    policy: 'auto',
    call: async (args) => {
      const row = await getFile(tenantId, String(args.fileId ?? ''));
      if (!row) {
        throw new Error('File not found in this workspace.');
      }
      if (!row.textContent) {
        return JSON.stringify({
          name: row.name,
          mime: row.mime,
          url: row.publicUrl,
          note: 'This file has no extractable text (it is media or an unsupported format). Use its URL.',
        });
      }
      // Untrusted content: the loop already wraps tool output, and the system
      // prompt forbids following instructions found inside it. A client brief
      // is a REQUEST, not a command chain — plan from it, don't blindly execute.
      return row.textContent.slice(0, 60_000);
    },
  });

  executors.set('save_note', {
    policy: 'auto',
    call: async (args) => {
      const name = String(args.name ?? 'note.md').slice(0, 120);
      const content = String(args.content ?? '');
      const row = await saveFile({
        tenantId,
        name: name.includes('.') ? name : `${name}.md`,
        bytes: Buffer.from(content, 'utf8'),
        mime: 'text/markdown',
        kind: 'note',
        source: 'agent',
      });
      return `Saved "${row?.name}" to the workspace library (id ${row?.id}).`;
    },
  });

  executors.set('save_file_from_url', {
    policy: 'auto', // writes only into this workspace's own storage
    call: async (args) => {
      // Same SSRF guard as fetch_url: the agent picks these URLs, sometimes
      // from untrusted page content, and we run next to the private network.
      const url = assertPublicUrl(String(args.url ?? ''));
      const name = String(args.name ?? '').trim() || 'download';

      const row = await saveRemoteFile({
        tenantId,
        url: url.toString(),
        name,
        source: 'agent',
      });

      return JSON.stringify({
        saved: true,
        id: row?.id,
        name: row?.name,
        sizeKb: Math.round((row?.sizeBytes ?? 0) / 1024),
        url: row?.publicUrl,
        note: 'The real file is now in the workspace Files library and will show up under Generated media. Use this URL when publishing — it is permanent.',
      });
    },
  });

  executors.set('report_issue', {
    policy: 'auto', // escalating a problem must never itself need approval
    call: async (args) => {
      const summary = String(args.summary ?? '').slice(0, 300);
      await captureIssue({
        tenantId,
        source: `agent-report: ${summary}`.slice(0, 160),
        error: new Error(String(args.detail ?? summary)),
        detail: { summary, reportedBy: 'agent' },
        reportedByAgent: true,
      });
      return 'Reported to the Artivio operator with the full context. Tell the user it has been escalated and that they do not need to do anything — but be honest that it may take time to fix, and do not promise a timeline.';
    },
  });

  // ── Web reading (fetch always; real browser when Browserless is configured) ─
  const web = buildWebTools();
  anthropicTools.push(...web.anthropicTools);
  for (const [name, executor] of web.executors) {
    executors.set(name, executor);
  }

  return { anthropicTools, executors };
}
