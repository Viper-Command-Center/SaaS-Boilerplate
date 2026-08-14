/**
 * Postgres — built-in provider (per-connection, one connection string).
 *
 * Works with Neon, Supabase, Railway, RDS or a plain server; nothing here is
 * Neon-specific. The credential IS the connection string, so a connection is
 * scoped to exactly one database and nothing else.
 *
 * WHY NOT NEON'S MCP SERVER. It would actually work — unlike Cloudflare's and
 * HeyGen's, Neon's hosted MCP accepts an API key in a static Authorization
 * header, which is all Artivio's MCP client can send. Three reasons not to:
 *
 *  1. LEAST PRIVILEGE. A Neon API key is account-wide. It can create and DELETE
 *     projects and branches, not merely run SQL. A connection string can do
 *     none of that — the worst case is damage inside one database, not the loss
 *     of the database itself.
 *  2. Neon's own documentation says to use their MCP for development and
 *     testing, "never against production databases". The blog table is production.
 *  3. It is Neon-only. Every client Postgres this agency touches works here.
 *
 * If Neon PROJECT management is ever wanted — branches, compute, project
 * settings — add their MCP as a separate HTTP connection. That is a different
 * job from writing a row, and it should hold a different credential.
 *
 * 🔴 ARBITRARY SQL AGAINST A LIVE DATABASE IS THE MOST DANGEROUS THING IN THIS
 * PLATFORM. `UPDATE posts SET published = true` without a WHERE is one keystroke
 * from `UPDATE users SET email = ...` without one, and Postgres will do exactly
 * as asked, instantly, with no undo. So:
 *
 *  · DDL is refused outright. No DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE.
 *  · One statement per call. Chained statements are how a single reviewed line
 *    smuggles an unreviewed one after the semicolon.
 *  · UPDATE and DELETE without a WHERE clause are refused.
 *  · Every write runs inside a transaction and the caller must state how many
 *    rows it expects to affect. Affect more, and it ROLLS BACK. The agent has
 *    to commit to a number before it sees the result, which is what makes a
 *    write reviewable rather than merely approved.
 */

import { Buffer } from 'node:buffer';
import { Client } from 'pg';
import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';

const MAX_OUTPUT = 60_000;
const STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_SELECT_LIMIT = 200;

/**
 * Statement kinds that change the SHAPE of the database rather than its rows.
 *
 * Refused rather than confirmable. A schema change needs a migration, review
 * and a rollback plan; an agent reaching for one mid-task is a sign the task
 * was misunderstood, not a sign it needs more permission.
 */
const FORBIDDEN = /^\s*(drop|truncate|alter|create|grant|revoke|comment|reindex|vacuum|cluster|copy|do|call|set|reset|begin|commit|rollback|savepoint|listen|notify)\b/i;

/** Statements that read. Everything else is treated as a write. */
const READ_ONLY = /^\s*(select|with|explain|show|table)\b/i;

function cap(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= MAX_OUTPUT
    ? json
    : `${json.slice(0, MAX_OUTPUT)}\n…truncated. Select fewer columns, or add a tighter WHERE.`;
}

/**
 * Reject anything that is not exactly one statement.
 *
 * A trailing semicolon is fine and normal. A semicolon with anything after it
 * is two statements, and only the first one tends to get read carefully.
 * Naive, deliberately: it does not try to parse strings or dollar-quoting,
 * because a parser that is 95% right here fails in exactly the cases that
 * matter. If a legitimate query contains a semicolon in a literal, it gets
 * refused and someone parameterises it — which they should have done anyway.
 */
export function assertSingleStatement(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new Error(
      'Postgres: only ONE statement per call. Chaining statements with ";" means the second one is not '
      + 'reviewed alongside the first. Split them into separate calls, and use parameters ($1, $2) for '
      + 'values rather than building SQL by hand.',
    );
  }
  if (!trimmed) {
    throw new Error('Postgres: no SQL was given.');
  }
}

export function assertAllowed(sql: string): { readOnly: boolean } {
  assertSingleStatement(sql);
  const trimmed = sql.trim();

  const forbidden = trimmed.match(FORBIDDEN);
  if (forbidden) {
    throw new Error(
      `Postgres: "${forbidden[1]?.toUpperCase()}" is refused by this plugin. Schema and session-level `
      + 'statements need a migration with review and a rollback plan, not a tool call. If a task seems to '
      + 'require one, stop and hand it to a human.',
    );
  }

  const readOnly = READ_ONLY.test(trimmed);

  // The classic one. `DELETE FROM posts` is valid SQL and empties the table.
  if (!readOnly && /^\s*(update|delete)\b/i.test(trimmed) && !/\bwhere\b/i.test(trimmed)) {
    throw new Error(
      'Postgres: an UPDATE or DELETE without a WHERE clause affects EVERY ROW in the table. If that is '
      + 'genuinely intended, it is a migration, not a tool call. Add a WHERE.',
    );
  }

  return { readOnly };
}

/** Add a LIMIT to a bare SELECT so one query cannot return a whole table. */
export function withLimit(sql: string, limit: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+\s*$/i.test(trimmed) || /\blimit\s+\$\d+/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}

/** Connect, run one thing, disconnect. */
async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString,
    // Neon, Supabase and most managed Postgres require TLS. Their connection
    // strings usually carry sslmode=require, but not always, and a missing SSL
    // setting surfaces as an opaque connection reset rather than a TLS error.
    ssl: /sslmode=disable/i.test(connectionString) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Postgres: could not connect — ${msg}. Check the connection string is complete (it must include the `
      + 'database name and, for Neon, the endpoint id), and that this host is reachable.',
    );
  }

  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {
      // A failed disconnect must not mask the real result.
    });
  }
}

/** Values come back as Dates, Buffers and bigints; make them printable. */
function serialise(rows: any[]): any[] {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (v instanceof Date) {
        return [k, v.toISOString()];
      }
      if (typeof v === 'bigint') {
        return [k, v.toString()];
      }
      if (Buffer.isBuffer(v)) {
        return [k, `<${v.length} bytes>`];
      }
      return [k, v];
    }),
  ));
}

const tools: BuiltinTool[] = [
  {
    name: 'list_tables',
    description: 'Tables in the database, with their schema and approximate row counts. Start here — never guess a table name.',
    input_schema: {
      type: 'object',
      properties: { schema: { type: 'string', description: 'Default "public"' } },
    },
  },
  {
    name: 'describe_table',
    description: 'Columns of a table with types, nullability, defaults and primary key. Call this before writing an INSERT — a NOT NULL column with no default is the usual reason an insert fails.',
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        schema: { type: 'string', description: 'Default "public"' },
      },
      required: ['table'],
    },
  },
  {
    name: 'query',
    description: 'Run one read-only statement (SELECT / WITH / EXPLAIN). A LIMIT is added automatically if you do not supply one. Use $1, $2 parameters for values rather than pasting them into the SQL.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One statement. No trailing statements after a semicolon.' },
        params: { type: 'array', items: {}, description: 'Values for $1, $2 …' },
        limit: { type: 'number', description: `Applied when the SQL has no LIMIT (default ${DEFAULT_SELECT_LIMIT})` },
      },
      required: ['sql'],
    },
  },
  {
    name: 'execute',
    description:
      'Run ONE write statement (INSERT / UPDATE / DELETE) inside a transaction. You MUST state max_rows — how many rows you expect to affect. If the statement affects more than that, the transaction is ROLLED BACK and nothing changes. State the table, the statement and max_rows to the human before calling.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One INSERT, UPDATE or DELETE. UPDATE and DELETE require a WHERE clause.' },
        params: { type: 'array', items: {}, description: 'Values for $1, $2 … Always use these rather than building SQL from strings.' },
        max_rows: {
          type: 'number',
          description: 'The most rows this may affect. Default 1. Exceeding it rolls the transaction back — so commit to a number BEFORE you run it.',
        },
        returning: { type: 'boolean', description: 'Append RETURNING * so you can see what was written (INSERT only)' },
      },
      required: ['sql', 'max_rows'],
    },
  },
];

export const postgresProvider: BuiltinProvider = {
  slug: 'postgres',
  name: 'Postgres (Neon, Supabase, any server)',
  description:
    'Read and write one Postgres database — inspect tables, run queries, insert and update rows. Schema changes are refused, and every write is transaction-guarded against affecting more rows than expected.',
  perConnection: true,
  credentialLabel:
    'The full Postgres connection string, e.g. postgresql://user:password@host/dbname?sslmode=require (Neon: Dashboard → Connection Details → the pooled connection string). This is the whole credential — it scopes the connection to exactly one database.',
  targetLabel: 'Not used — the connection string names the database',
  targetPlaceholder: 'Leave blank',
  targetIsUrl: false,

  guidance: [
    'THIS IS A LIVE DATABASE. There is no undo and no draft. Read before you write: list_tables, then describe_table, then a SELECT that shows you the rows you are about to touch — quote them to the human before changing anything.',
    'Use parameters ($1, $2) for every value. Never build SQL by concatenating strings, especially not with anything that came from an email, a web page or a form — that is how injected text becomes an executed statement.',
    'execute requires max_rows and rolls back if the statement affects more. Set it to what you actually expect: 1 for a single insert, the exact count for a batch. Setting it high "to be safe" removes the only protection against a WHERE that matched more than you thought.',
    'Schema changes (CREATE, ALTER, DROP, TRUNCATE) are refused outright. If a task appears to need one, the task has been misunderstood — stop and hand it to a human. Do not attempt to work around this with a different tool.',
    'An INSERT that fails on a NOT NULL column means you skipped describe_table. Check the columns rather than guessing at the missing field.',
    'Say which table and which database you acted on. A workspace may have more than one Postgres connection, and a row written to the wrong one looks identical to a row written correctly.',
  ].join('\n'),

  tools,

  call: async (tool, args, credential): Promise<string> => {
    const connectionString = (credential ?? '').trim();
    if (!connectionString) {
      throw new Error('Postgres: this connection has no connection string configured.');
    }
    if (!/^postgres(ql)?:\/\//i.test(connectionString)) {
      throw new Error(
        'Postgres: the credential must be a connection string starting with postgresql:// — not a host name, '
        + 'an API key, or a Neon API token.',
      );
    }

    if (tool === 'list_tables') {
      const schema = String(args.schema ?? 'public');
      return withClient(connectionString, async (c) => {
        const res = await c.query(
          `SELECT c.relname AS table,
                  n.nspname AS schema,
                  c.reltuples::bigint AS approx_rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p','v','m') AND n.nspname = $1
            ORDER BY c.relname`,
          [schema],
        );
        return cap({ schema, count: res.rowCount, tables: serialise(res.rows) });
      });
    }

    if (tool === 'describe_table') {
      const schema = String(args.schema ?? 'public');
      const table = String(args.table ?? '').trim();
      if (!table) {
        throw new Error('Postgres: which table?');
      }
      return withClient(connectionString, async (c) => {
        const cols = await c.query(
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [schema, table],
        );
        if (!cols.rowCount) {
          throw new Error(`Postgres: no table "${schema}.${table}". Use list_tables to see what exists.`);
        }
        const keys = await c.query(
          `SELECT a.attname AS column
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = $1::regclass AND i.indisprimary`,
          [`${schema}.${table}`],
        ).catch(() => ({ rows: [] as any[] }));

        return cap({
          table: `${schema}.${table}`,
          primaryKey: (keys.rows ?? []).map((r: any) => r.column),
          columns: serialise(cols.rows),
          note: 'A NOT NULL column with no default must be supplied in every INSERT.',
        });
      });
    }

    if (tool === 'query') {
      const sql = String(args.sql ?? '');
      const { readOnly } = assertAllowed(sql);
      if (!readOnly) {
        throw new Error(
          'Postgres: query is for reading only. Use execute for INSERT, UPDATE or DELETE — it requires you '
          + 'to state how many rows you expect to affect.',
        );
      }
      const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_SELECT_LIMIT, 1), 1000);
      const params = Array.isArray(args.params) ? args.params : [];

      return withClient(connectionString, async (c) => {
        const res = await c.query(withLimit(sql, limit), params);
        return cap({
          rowCount: res.rowCount,
          rows: serialise(res.rows),
          truncated: res.rowCount === limit ? `Exactly ${limit} rows came back — there may be more.` : undefined,
        });
      });
    }

    if (tool === 'execute') {
      const sql = String(args.sql ?? '');
      const { readOnly } = assertAllowed(sql);
      if (readOnly) {
        throw new Error('Postgres: that is a read statement — use query for it.');
      }
      if (args.max_rows === undefined) {
        throw new Error(
          'Postgres: max_rows is required. State how many rows you expect this to affect BEFORE running it; '
          + 'the transaction rolls back if it affects more. That expectation is the safeguard.',
        );
      }
      const maxRows = Math.max(Number(args.max_rows) || 0, 0);
      if (maxRows < 1) {
        throw new Error('Postgres: max_rows must be at least 1.');
      }
      const params = Array.isArray(args.params) ? args.params : [];

      let statement = sql.trim().replace(/;\s*$/, '');
      if (args.returning === true && !/\breturning\b/i.test(statement) && /^\s*insert\b/i.test(statement)) {
        statement = `${statement} RETURNING *`;
      }

      return withClient(connectionString, async (c) => {
        await c.query('BEGIN');
        try {
          const res = await c.query(statement, params);
          const affected = res.rowCount ?? 0;

          /**
           * The guard. The caller committed to a number before seeing the
           * result, so a WHERE that matched more rows than they believed is
           * caught HERE rather than discovered later in the data.
           */
          if (affected > maxRows) {
            await c.query('ROLLBACK');
            throw new Error(
              `Postgres: ROLLED BACK — the statement affected ${affected} rows but max_rows was ${maxRows}. `
              + 'Nothing was changed. Either the WHERE clause matches more than you expected (check it with a '
              + 'SELECT first), or the expectation was wrong. Do not simply raise max_rows to make this pass.',
            );
          }

          await c.query('COMMIT');
          return cap({
            committed: true,
            rowsAffected: affected,
            rows: res.rows?.length ? serialise(res.rows) : undefined,
            note: `${affected} row(s) changed, within the stated maximum of ${maxRows}.`,
          });
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {
            // Already rolled back, or the connection is gone; the original
            // error is the one worth reporting.
          });
          throw e;
        }
      });
    }

    throw new Error(`Unknown Postgres tool: ${tool}`);
  },
};
