/**
 * Platform tools — always available to the agent in every workspace, policy
 * 'auto' (they only touch the tenant's own dashboard/data, never the outside
 * world). This is how the agent reshapes the dashboard on request:
 * "show me weekly Shopify revenue" → write_dataset + create_panel.
 */

import type { AnthropicTool } from '@/libs/mcp/registry';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { dashboardPanels, datasets, scheduledTasks } from '@/models/Schema';

export type PlatformExecutor = {
  policy: 'auto';
  call: (args: Record<string, unknown>) => Promise<string>;
};

const PANEL_TYPES = ['kpi', 'timeseries', 'table', 'markdown'];

export function buildPlatformTools(tenantId: string): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const executors = new Map<string, PlatformExecutor>();

  const anthropicTools: AnthropicTool[] = [
    {
      name: 'list_panels',
      description: 'List the dashboard panels currently configured in this workspace, with their ids, types and configs.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'create_panel',
      description: 'Create a dashboard panel. Types: kpi (config: datasetKey, valueField, label?), timeseries (config: datasetKey, valueField), table (config: datasetKey, columns?: string[], limit?: number), markdown (config: text). Panels render on the workspace dashboard immediately.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: PANEL_TYPES },
          title: { type: 'string' },
          config: { type: 'object' },
          position: { type: 'number' },
        },
        required: ['type', 'title', 'config'],
      },
    },
    {
      name: 'update_panel',
      description: 'Update an existing dashboard panel by id (title, config, position).',
      input_schema: {
        type: 'object',
        properties: {
          panelId: { type: 'string' },
          title: { type: 'string' },
          config: { type: 'object' },
          position: { type: 'number' },
        },
        required: ['panelId'],
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
  ];

  executors.set('list_panels', {
    policy: 'auto',
    call: async () => {
      const rows = await db
        .select()
        .from(dashboardPanels)
        .where(eq(dashboardPanels.tenantId, tenantId))
        .orderBy(asc(dashboardPanels.position));
      return JSON.stringify(rows.map(r => ({ id: r.id, type: r.type, title: r.title, config: r.config, position: r.position })));
    },
  });

  executors.set('create_panel', {
    policy: 'auto',
    call: async (args) => {
      const type = String(args.type ?? '');
      if (!PANEL_TYPES.includes(type)) {
        throw new Error(`Invalid panel type. Use one of: ${PANEL_TYPES.join(', ')}`);
      }
      const [row] = await db
        .insert(dashboardPanels)
        .values({
          tenantId,
          type,
          title: String(args.title ?? 'Untitled'),
          config: args.config ?? {},
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
      const result = await db
        .update(dashboardPanels)
        .set({
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(args.config !== undefined ? { config: args.config } : {}),
          ...(typeof args.position === 'number' ? { position: args.position } : {}),
        })
        .where(and(eq(dashboardPanels.id, panelId), eq(dashboardPanels.tenantId, tenantId)))
        .returning({ id: dashboardPanels.id });
      if (result.length === 0) {
        throw new Error('Panel not found in this workspace.');
      }
      return 'Panel updated.';
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

  return { anthropicTools, executors };
}
