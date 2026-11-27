import { withGlobal } from "@wos/db";
import { logger } from "../logger";
import type { SuppressionStore } from "./bounces";

/**
 * Durable platform suppression store (proposed migration 0025). Bounces and complaints for
 * the SaaS's own transactional mail are platform-wide: one row per address, no tenant.
 *
 * Degradation, deliberate: while 0025 is unapplied the store falls back to a process-local
 * map and logs a warning — sending continues (blocking password resets on a missing table
 * is worse than re-sending to a bounced address), but the bounce webhook answers 503 so the
 * provider keeps retrying until the durable store exists. Wire MAIL_WEBHOOK_SECRET and apply
 * 0025 together at launch.
 */

const norm = (a: string) => a.trim().toLowerCase();

let tableReady: boolean | undefined;

async function tableExists(): Promise<boolean> {
  if (tableReady !== undefined) return tableReady;
  try {
    tableReady = await withGlobal(async (tx) => {
      const r = await tx.raw.query(`SELECT to_regclass('platform_mail_suppressions') AS t`);
      return (r.rows[0] as { t: string | null }).t !== null;
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "db" }, "platform mail suppression: table probe failed; using in-memory fallback");
    tableReady = false;
  }
  if (!tableReady) logger.warn("platform mail suppression: proposed 0025 not applied — suppressions are process-local only");
  return tableReady;
}

/** True when bounce/complaint events can be persisted (webhook answers 503 otherwise, so providers retry). */
export async function platformSuppressionDurable(): Promise<boolean> {
  return tableExists();
}

class DbStore implements SuppressionStore {
  async isSuppressed(address: string): Promise<boolean> {
    return withGlobal(async (tx) => {
      const r = await tx.raw.query(`SELECT 1 FROM platform_mail_suppressions WHERE address = $1`, [norm(address)]);
      return r.rows.length > 0;
    });
  }
  async suppress(address: string, reason: "bounce" | "complaint"): Promise<void> {
    await withGlobal(async (tx) => {
      await tx.raw.query(
        `INSERT INTO platform_mail_suppressions (address, reason, source) VALUES ($1, $2, 'platform') ON CONFLICT (address) DO NOTHING`,
        [norm(address), reason],
      );
    });
  }
  async recordSoftBounce(address: string): Promise<number> {
    return withGlobal(async (tx) => {
      const r = await tx.raw.query(
        `INSERT INTO platform_mail_soft_bounces (address, count) VALUES ($1, 1)
         ON CONFLICT (address) DO UPDATE SET count = platform_mail_soft_bounces.count + 1, updated_at = now()
         RETURNING count`,
        [norm(address)],
      );
      return (r.rows[0] as { count: number }).count;
    });
  }
}

class MemoryFallback implements SuppressionStore {
  readonly suppressed = new Map<string, "bounce" | "complaint">();
  readonly soft = new Map<string, number>();
  async isSuppressed(a: string) { return this.suppressed.has(norm(a)); }
  async suppress(a: string, r: "bounce" | "complaint") { this.suppressed.set(norm(a), r); }
  async recordSoftBounce(a: string) { const n = (this.soft.get(norm(a)) ?? 0) + 1; this.soft.set(norm(a), n); return n; }
}

let pinned: SuppressionStore | undefined;
const memory = new MemoryFallback();
const db = new DbStore();

/**
 * The process-wide store: DB when proposed 0025 exists, else the labelled in-memory fallback.
 * Note the probe is cached per process; a newly applied migration needs a restart to take effect.
 */
export async function platformSuppressionStore(): Promise<{ store: SuppressionStore; durable: boolean }> {
  if (pinned) return { store: pinned, durable: true };
  return (await tableExists()) ? { store: db, durable: true } : { store: memory, durable: false };
}

/**
 * Sync-friendly wrapper for getMailSender(): each send resolves the current store
 * (the durability probe is cached after the first call, so this costs one flag read).
 */
export function lazyPlatformSuppressionStore(): SuppressionStore {
  return {
    isSuppressed: async (a) => (await platformSuppressionStore()).store.isSuppressed(a),
    suppress: async (a, r) => (await platformSuppressionStore()).store.suppress(a, r),
    recordSoftBounce: async (a) => (await platformSuppressionStore()).store.recordSoftBounce(a),
  };
}

/** Tests only. */
export function setPlatformSuppressionStoreForTests(store: SuppressionStore | undefined): void {
  pinned = store;
  if (!store) tableReady = undefined;
}
