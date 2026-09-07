import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Env } from '@/libs/Env';
import { logger } from '@/libs/Logger';
import * as schema from '@/models/Schema';

// Need a database for production? Check out https://get.neon.com/BMFYNtx
// Tested and compatible with Next.js Boilerplate
export const createDbConnection = () => {
  const pool = new Pool({
    connectionString: Env.DATABASE_URL,
    // Long tool calls (a 40 s book render, a 4-min mission step) leave the
    // pool idle; without keepalive a proxy can drop the TCP session and the
    // next query fails with "Connection terminated unexpectedly".
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on('error', (error) => {
    logger.error(`Database pool error: ${error.message}`);
  });

  return drizzle({
    client: pool,
    schema,
  });
};
