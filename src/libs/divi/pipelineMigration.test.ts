import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('Divi pipeline migration (isolated PostgreSQL)', () => {
  it('creates receipt/design tables, enforces scoped uniqueness and updates playbooks', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE mcp_connections(id uuid PRIMARY KEY); CREATE TABLE playbooks(scope text, title text, body text);
        INSERT INTO playbooks VALUES ('wp-sites','Divi 5 conventions','Old instructions');`);
      const sql = fs.readFileSync(path.join(process.cwd(), 'migrations/0035_divi_build_pipeline.sql'), 'utf8');
      await db.exec(sql);
      await db.exec(sql); // Hand-written migration is safe to replay.
      const tenant = '00000000-0000-0000-0000-000000000001';
      const connection = '00000000-0000-0000-0000-000000000002';
      await db.exec(`INSERT INTO tenants VALUES ('${tenant}'); INSERT INTO mcp_connections VALUES ('${connection}');
        INSERT INTO divi_builds(tenant_id,connection_id,build_key,target,plan) VALUES ('${tenant}','${connection}','home','https://example.com','{}');`);

      await expect(db.exec(`INSERT INTO divi_builds(tenant_id,connection_id,build_key,target,plan) VALUES ('${tenant}','${connection}','home','https://example.com','{}');`)).rejects.toThrow(/unique/i);

      const result = await db.query<{ body: string }>('SELECT body FROM playbooks');

      expect(result.rows[0]!.body).toContain('Presets are OPTIONAL');

      const receipt = await db.query<{ status: string }>('SELECT status FROM divi_builds');

      expect(receipt.rows[0]!.status).toBe('planned');
    } finally {
      await db.close();
    }
  });
});
