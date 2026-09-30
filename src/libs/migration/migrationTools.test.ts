import { describe, expect, it } from 'vitest';
import { buildMigrationTools } from '@/libs/migration/migrationTools';

describe('migration read-back tools (Phase 48.2)', () => {
  const { anthropicTools, executors } = buildMigrationTools('tenant-1');

  it('registers migration_list and migration_read as auto, read-only tools', () => {
    const names = anthropicTools.map(t => t.name).sort();

    expect(names).toEqual(['migration_list', 'migration_read']);
    expect(executors.get('migration_list')?.policy).toBe('auto');
    expect(executors.get('migration_read')?.policy).toBe('auto');
  });

  it('migration_read requires both jobId and path (no silent DB call on bad input)', async () => {
    const read = executors.get('migration_read')!;

    await expect(read.call({ jobId: '', path: '' })).rejects.toThrow(/needs jobId and path/);
    await expect(read.call({ jobId: 'abc' })).rejects.toThrow(/needs jobId and path/);
    await expect(read.call({ path: 'pages/home.md' })).rejects.toThrow(/needs jobId and path/);
  });

  it('migration_read description steers away from read_file for migration output', () => {
    const read = anthropicTools.find(t => t.name === 'migration_read')!;

    expect(read.description).toMatch(/read_file cannot reach/);
  });
});
