/**
 * Postgres adapter — the refusals.
 *
 * Every test here is a way a live database gets damaged with no undo. The
 * approvals gateway shows a human some SQL; it does not make them notice that
 * a DELETE has no WHERE at the end of a long line, or that a semicolon has a
 * second statement after it. That noticing is what these do.
 *
 * The pure guards are tested directly, without a database.
 */

import { describe, expect, it } from 'vitest';
import { assertAllowed, assertSingleStatement, withLimit } from '@/libs/plugins/postgres';

describe('assertSingleStatement', () => {
  it('accepts one statement, with or without a trailing semicolon', () => {
    expect(() => assertSingleStatement('SELECT 1')).not.toThrow();
    expect(() => assertSingleStatement('SELECT 1;')).not.toThrow();
    expect(() => assertSingleStatement('SELECT 1;   ')).not.toThrow();
  });

  /**
   * The point of the whole check: a reviewer reads the first statement and
   * approves it. The one after the semicolon rides along unread.
   */
  it('refuses a second statement hiding after a semicolon', () => {
    expect(() => assertSingleStatement('SELECT 1; DROP TABLE users'))
      .toThrow(/only ONE statement/);
  });

  it('refuses empty SQL', () => {
    expect(() => assertSingleStatement('   ')).toThrow(/no SQL/);
  });
});

describe('assertAllowed — schema changes', () => {
  it.each([
    ['DROP TABLE posts'],
    ['TRUNCATE posts'],
    ['ALTER TABLE posts ADD COLUMN x int'],
    ['CREATE TABLE x (id int)'],
    ['GRANT ALL ON posts TO public'],
    ['REVOKE ALL ON posts FROM public'],
  ])('refuses %s', (sql) => {
    expect(() => assertAllowed(sql)).toThrow(/refused by this plugin/);
  });

  it('refuses regardless of casing or leading whitespace', () => {
    expect(() => assertAllowed('   drop table posts')).toThrow(/refused/);
  });

  // Transaction control belongs to the adapter, which wraps every write itself.
  // An agent issuing its own COMMIT could commit a half-finished change.
  it('refuses the agent driving its own transaction', () => {
    expect(() => assertAllowed('COMMIT')).toThrow(/refused/);
    expect(() => assertAllowed('BEGIN')).toThrow(/refused/);
  });
});

describe('assertAllowed — the missing WHERE', () => {
  /**
   * `DELETE FROM posts` is perfectly valid SQL that empties the table, and it
   * differs from a correct statement by an absence rather than a mistake — so
   * there is nothing on the line for a reviewer to notice.
   */
  it('refuses DELETE with no WHERE', () => {
    expect(() => assertAllowed('DELETE FROM posts')).toThrow(/affects EVERY ROW/);
  });

  it('refuses UPDATE with no WHERE', () => {
    expect(() => assertAllowed('UPDATE posts SET published = true')).toThrow(/affects EVERY ROW/);
  });

  it('allows them once a WHERE is present', () => {
    expect(() => assertAllowed('DELETE FROM posts WHERE id = $1')).not.toThrow();
    expect(() => assertAllowed('UPDATE posts SET published = true WHERE id = $1')).not.toThrow();
  });

  // An INSERT has nothing to over-match, so a WHERE is meaningless there.
  it('does not demand a WHERE on INSERT', () => {
    expect(() => assertAllowed('INSERT INTO posts (title) VALUES ($1)')).not.toThrow();
  });
});

describe('assertAllowed — read vs write', () => {
  it.each([
    ['SELECT * FROM posts'],
    ['WITH x AS (SELECT 1) SELECT * FROM x'],
    ['EXPLAIN SELECT 1'],
  ])('classifies %s as read-only', (sql) => {
    expect(assertAllowed(sql).readOnly).toBe(true);
  });

  it.each([
    ['INSERT INTO posts (title) VALUES ($1)'],
    ['UPDATE posts SET title = $1 WHERE id = $2'],
    ['DELETE FROM posts WHERE id = $1'],
  ])('classifies %s as a write', (sql) => {
    expect(assertAllowed(sql).readOnly).toBe(false);
  });
});

describe('withLimit', () => {
  it('adds a limit to a bare SELECT', () => {
    expect(withLimit('SELECT * FROM posts', 200)).toBe('SELECT * FROM posts LIMIT 200');
  });

  // Overriding an explicit LIMIT would silently change what the caller asked for.
  it('leaves an existing LIMIT alone', () => {
    expect(withLimit('SELECT * FROM posts LIMIT 5', 200)).toBe('SELECT * FROM posts LIMIT 5');
  });

  it('leaves a parameterised LIMIT alone', () => {
    expect(withLimit('SELECT * FROM posts LIMIT $1', 200)).toBe('SELECT * FROM posts LIMIT $1');
  });

  it('strips a trailing semicolon so the LIMIT is not appended after it', () => {
    expect(withLimit('SELECT * FROM posts;', 50)).toBe('SELECT * FROM posts LIMIT 50');
  });
});

describe('credential validation', () => {
  it('rejects a Neon API key pasted where a connection string belongs', async () => {
    const { postgresProvider } = await import('@/libs/plugins/postgres');

    await expect(postgresProvider.call('list_tables', {}, 'napi_abc123'))
      .rejects
      .toThrow(/must be a connection string/);
  });

  it('rejects an empty credential', async () => {
    const { postgresProvider } = await import('@/libs/plugins/postgres');

    await expect(postgresProvider.call('list_tables', {}, ''))
      .rejects
      .toThrow(/no connection string/);
  });
});

describe('execute preconditions', () => {
  const CONN = 'postgresql://u:p@host/db';

  /**
   * max_rows is the safeguard, so it cannot be optional. Defaulting it would
   * mean the common case runs unguarded.
   */
  it('refuses to run a write without max_rows', async () => {
    const { postgresProvider } = await import('@/libs/plugins/postgres');

    await expect(postgresProvider.call(
      'execute',
      { sql: 'INSERT INTO posts (title) VALUES ($1)', params: ['x'] },
      CONN,
    )).rejects.toThrow(/max_rows is required/);
  });

  it('refuses a read statement sent to execute', async () => {
    const { postgresProvider } = await import('@/libs/plugins/postgres');

    await expect(postgresProvider.call(
      'execute',
      { sql: 'SELECT * FROM posts', max_rows: 1 },
      CONN,
    )).rejects.toThrow(/use query for it/);
  });

  it('refuses a write statement sent to query', async () => {
    const { postgresProvider } = await import('@/libs/plugins/postgres');

    await expect(postgresProvider.call(
      'query',
      { sql: 'DELETE FROM posts WHERE id = 1' },
      CONN,
    )).rejects.toThrow(/query is for reading only/);
  });

  // Guards must run before any connection is attempted, so a dangerous
  // statement is refused even when the database is unreachable.
  it('refuses dangerous SQL before trying to connect', async () => {
    const { postgresProvider } = await import('@/libs/plugins/postgres');

    await expect(postgresProvider.call(
      'execute',
      { sql: 'DROP TABLE posts', max_rows: 1 },
      'postgresql://nobody@127.0.0.1:1/none',
    )).rejects.toThrow(/refused by this plugin/);
  });
});
