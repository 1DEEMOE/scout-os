import pg from "pg";

// INTERNAL. Only context.ts (withTenant / withUser / withGlobal) and the auth
// library get a connection. ESLint blocks raw `pg` imports outside packages/db.

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

let sidePool: pg.Pool | undefined;

/**
 * A small separate pool for out-of-band writes (denial audits) made while the
 * caller still holds a main-pool connection. Using the main pool for those
 * would deadlock once every main connection waits for one more. Work on this
 * pool never opens another transaction, so it can't deadlock itself.
 */
export function getSidePool(): pg.Pool {
  if (!sidePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sidePool = new pg.Pool({ connectionString: url, max: 3 });
  }
  return sidePool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  await sidePool?.end();
  pool = undefined;
  sidePool = undefined;
}
