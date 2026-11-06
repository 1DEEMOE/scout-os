import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { getPool, getSidePool } from "./client";
import * as schema from "./schema";

export type Schema = typeof schema;

/**
 * A tenant-, user- or globally-scoped transaction. `raw` is the same client,
 * exposed so the job queue can enqueue inside this transaction.
 */
export type Tx = NodePgDatabase<Schema> & { raw: Pick<pg.PoolClient, "query"> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export class InvalidTenantError extends Error {
  constructor() {
    super("tenant id must be a UUID");
    this.name = "InvalidTenantError";
  }
}

async function inTransaction<T>(settings: Record<string, string>, fn: (tx: Tx) => Promise<T>, pool: pg.Pool = getPool()): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(settings)) {
      // set_config(..., true) is transaction-local: it can't outlive this transaction.
      await client.query("SELECT set_config($1, $2, true)", [key, value]);
    }
    const tx = Object.assign(drizzle(client, { schema }), { raw: client }) as Tx;
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs fn in a transaction scoped to one tenant. RLS policies read app.tenant_id. */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) return Promise.reject(new InvalidTenantError());
  return inTransaction({ "app.tenant_id": tenantId }, fn);
}

/**
 * Like withTenant, on a separate pool. Only for short out-of-band writes made
 * while an outer transaction is open (audit of a refusal the outer one will
 * roll back). Never call withTenant from inside it.
 */
export function withTenantOutOfBand<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) return Promise.reject(new InvalidTenantError());
  return inTransaction({ "app.tenant_id": tenantId }, fn, getSidePool());
}

/** User context, no tenant: policies expose only that user's memberships and orgs. */
export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!userId) return Promise.reject(new Error("user id required"));
  return inTransaction({ "app.user_id": userId }, fn);
}

/**
 * Public booking-link lookup: no tenant, no user. The 0019 policy lets this
 * transaction read only the one front_desk_channels row whose token_hash
 * matches. Never use it for anything else.
 */
export function withFrontDeskToken<T>(tokenHash: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return Promise.reject(new Error("token hash must be 64 hex characters"));
  return inTransaction({ "app.front_desk_token_hash": tokenHash }, fn);
}

/** Global tables only (users). Tenant tables return no rows here. */
export function withGlobal<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction({}, fn);
}
