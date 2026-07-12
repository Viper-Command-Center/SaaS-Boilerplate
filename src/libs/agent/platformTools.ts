/**
 * Platform tools — always available to the agent in every workspace, policy
 * 'auto' (they only touch the tenant's own dashboard/data, never the outside
 * world). This is how the agent reshapes the dashboard on request:
 * "show me weekly Shopify revenue" → write_dataset + create_panel.
 */

import type { AnthropicTool } from '@/libs/mcp/registry';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { dashboardPanels, datasets } from '@/models/Schema';

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
