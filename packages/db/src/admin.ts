import pg from "pg";

/**
 * Superuser / BYPASSRLS connection for platform scanners only (e.g. lost
 * routine-run recovery). FORCE ROW LEVEL SECURITY means the table owner cannot
 * list across tenants; this URL must be a role that can. Never used for
 * ordinary app reads or writes.
 *
 * Set DATABASE_URL_ADMIN (tests: TEST_DATABASE_URL_ADMIN).
 */
export function adminUrl(): string | undefined {
  return process.env.DATABASE_URL_ADMIN || process.env.TEST_DATABASE_URL_ADMIN || undefined;
}

export async function adminQuery<R extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const url = adminUrl();
  if (!url) throw new Error("DATABASE_URL_ADMIN is not set; cross-tenant scanners are disabled");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** One admin connection for a maintenance job (e.g. secrets rotation). Caller manages BEGIN/COMMIT. */
export async function withAdminClient<T>(fn: (q: <R extends pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const url = adminUrl();
  if (!url) throw new Error("DATABASE_URL_ADMIN is not set; cross-tenant maintenance is disabled");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(async (text, params = []) => (await c.query(text, params)).rows);
  } finally {
    await c.end();
  }
}
