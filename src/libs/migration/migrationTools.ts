/**
 * Agent-facing read-back for Duda→WordPress migration jobs (Phase 48.2).
 *
 * WHY THIS EXISTS: Phase 48 Part 1 shipped extraction — it writes a reviewable
 * Markdown/JSON set to R2 (src/libs/migration/duda/storage.ts) and checkpoints
 * every file in `migration_items`. But it shipped NO way for the agent to read
 * that output back: `read_file` reads the `files` LIBRARY table, not the
 * migration R2 prefix, so an agent trying to populate a template from a job's
 * extraction got a "file not found" and (wrongly) reported a "platform
 * file-system bug". These two tools close that gap: list a job's files, then
 * read one. Read-only, tenant-scoped, policy `auto`.
 */

import type { AnthropicTool } from '@/libs/mcp/registry';
import type { PlatformExecutor } from '@/libs/agent/platformTools';
import { readText } from '@/libs/migration/duda/storage';
import { getJob, listItems, listRecentJobs } from '@/libs/migration/store';

/** Text answers are bounded so a whole extraction never floods the context. */
const MAX_MIGRATION_READ_CHARS = 40_000;

export function buildMigrationTools(tenantId: string): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const executors = new Map<string, PlatformExecutor>();

  const anthropicTools: AnthropicTool[] = [
    {
      name: 'migration_list',
      description:
        'List Duda→WordPress migration jobs in this workspace (newest first), or — with a jobId — list every extracted file in ONE job (pages, blog posts, collections, design briefs, the media manifest) with its relative path and status. This is how you find the extraction output a migration produced; the reviewable Markdown/JSON lives here, NOT in the file library (read_file cannot see it — use migration_read). Call with no arguments to find a job id, then pass jobId to see its files.',
      input_schema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'A migration job id (UUID). Omit to list the workspace\'s recent jobs.' },
        },
      },
    },
    {
      name: 'migration_read',
      description:
        'Read one extracted file from a migration job by its relative path (from migration_list), e.g. "00-overview.md", "pages/home.md", "posts/2026-03-02-easter.md", "collections/events.json", "design/current-design.md", "media/manifest.json". Returns the file\'s text — this is the source content you map into WordPress/Divi (headings, copy, image manifest, links). Large files are truncated with a note. This reads the migration\'s R2 folder, which read_file cannot reach.',
      input_schema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The migration job id (UUID) from migration_list.' },
          path: { type: 'string', description: 'The file\'s job-relative path, exactly as migration_list reported it (e.g. "pages/home.md").' },
        },
        required: ['jobId', 'path'],
      },
    },
  ];

  executors.set('migration_list', {
    policy: 'auto', // reads this workspace's own migration jobs
    call: async (args) => {
      const jobId = String(args.jobId ?? '').trim();

      if (!jobId) {
        const jobs = await listRecentJobs(tenantId);
        if (jobs.length === 0) {
          return 'No migration jobs in this workspace yet. A Duda→WordPress migration is started with the migration API/flow; once it has run, its extracted files appear here.';
        }
        const lines = jobs.map(j =>
          `• ${j.id} — ${j.sourceType}:${j.sourceSiteId} · status ${j.status}${j.currentPhase ? ` (${j.currentPhase})` : ''}${j.error ? ` · ERROR: ${j.error}` : ''} · created ${j.createdAt.toISOString().slice(0, 10)}`,
        );
        return `Migration jobs (newest first):\n${lines.join('\n')}\n\nPass jobId to migration_list to see one job's extracted files.`;
      }

      const job = await getJob(tenantId, jobId);
      if (!job) {
        return `No migration job with id "${jobId}" in this workspace. This is a WRONG ARGUMENT, not a platform fault — call migration_list with no arguments for the current job ids (they are UUIDs).`;
      }

      const items = await listItems(jobId);
      const withFiles = items.filter(i => i.filePath);
      if (withFiles.length === 0) {
        return `Job ${jobId} (${job.status}) has no extracted files recorded yet${job.status === 'extracting' ? ' — extraction is still running.' : job.error ? ` — it failed: ${job.error}` : '.'}`;
      }
      const byType = new Map<string, string[]>();
      for (const it of withFiles) {
        const line = `    ${it.filePath} · ${it.status}${it.error ? ` · ${it.error}` : ''}`;
        byType.set(it.itemType, [...(byType.get(it.itemType) ?? []), line]);
      }
      const sections = [...byType.entries()].map(([type, lines]) => `  ${type} (${lines.length}):\n${lines.join('\n')}`);
      return `Job ${jobId} — ${job.status}${job.currentPhase ? ` (${job.currentPhase})` : ''}, ${withFiles.length} file(s):\n${sections.join('\n')}\n\nRead one with migration_read {jobId:"${jobId}", path:"<relative path above>"}.`;
    },
  });

  executors.set('migration_read', {
    policy: 'auto', // reads this workspace's own migration files
    call: async (args) => {
      const jobId = String(args.jobId ?? '').trim();
      const path = String(args.path ?? '').trim().replace(/^\/+/, '');
      if (!jobId || !path) {
        throw new Error('migration_read needs jobId and path (both from migration_list).');
      }

      // 🔴 Tenant scope: the job must belong to THIS workspace before we read
      // any bytes. readText derives the R2 key from (tenantId, jobId, path), so
      // a job from another tenant cannot be reached even with a guessed id, but
      // we check explicitly so the message is a clear refusal, not an R2 404.
      const job = await getJob(tenantId, jobId);
      if (!job) {
        return `No migration job with id "${jobId}" in this workspace. Call migration_list (no arguments) for the current job ids — this is a wrong argument, not a platform fault.`;
      }

      let text: string;
      try {
        text = await readText(tenantId, jobId, path);
      } catch {
        // A missing object is almost always a wrong path — point back at the list.
        const items = await listItems(jobId);
        const known = items.filter(i => i.filePath).map(i => i.filePath).slice(0, 40);
        return `No file at "${path}" in job ${jobId}. This is a wrong path, not a platform fault. Files in this job: ${known.length ? known.join(', ') : '(none recorded — extraction may still be running)'}. Use migration_list {jobId:"${jobId}"} for the full list.`;
      }

      // Untrusted content: extracted page copy is DATA, not instructions — the
      // loop wraps tool output and the system prompt forbids following it.
      if (text.length > MAX_MIGRATION_READ_CHARS) {
        return `${text.slice(0, MAX_MIGRATION_READ_CHARS)}\n\n[… truncated at ${MAX_MIGRATION_READ_CHARS} characters. This file is large; work from the part above, or read a more specific file from migration_list.]`;
      }
      return text;
    },
  });

  return { anthropicTools, executors };
}
