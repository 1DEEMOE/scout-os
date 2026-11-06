import pg from "pg";

/** Owner-role client for test setup only. The app never uses this role. */
async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Empties every app table and the job queue. TRUNCATE is not subject to RLS. */
export function resetDb(): Promise<void> {
  return asOwner(async (c) => {
    const { rows } = await c.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
    );
    await c.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
    await c.query("DELETE FROM pgboss.job");
  });
}

export function seedUser(id: string, email: string, name = id): Promise<void> {
  return asOwner(async (c) => {
    await c.query("INSERT INTO users (id, name, email) VALUES ($1, $2, $3)", [id, name, email]);
  });
}

export function ownerQuery<R extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  return asOwner(async (c) => (await c.query<R>(text, params)).rows);
}
