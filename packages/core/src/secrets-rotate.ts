/**
 * Re-seals every stored secret under the current key (see secrets.ts and
 * docs/plans/secrets-rotation-runbook.md). Operator-run maintenance, never part
 * of the app: it needs DATABASE_URL_ADMIN to reach every tenant, and a typed
 * confirmation of the new key id (tier 4: secrets, second confirmation).
 *
 * Safe to re-run: rows already on the current key are skipped. A row that
 * can't be opened is left untouched and reported, so nothing is ever lost.
 */
import { adminUrl, withAdminClient, withTenant } from "@wos/db";
import { recordAudit } from "./audit";
import { logger } from "./logger";
import { currentSecretKeyId, resealSecret, secretKeyIdOf } from "./secrets";

const TARGETS = [
  { table: "integration_connections", column: "secret_ciphertext", alsoSet: "secret_ref" },
  { table: "payment_destinations", column: "ciphertext", alsoSet: null },
  { table: "payment_detail_changes", column: "proposed_ciphertext", alsoSet: null },
] as const;

export interface RotationReport {
  keyId: string;
  dryRun: boolean;
  tables: { table: string; total: number; alreadyCurrent: number; resealed: number; unreadable: { tenantId: string; id: string; keyId: string | null }[] }[];
}

export async function rotateStoredSecrets(opts: { confirmKeyId: string; dryRun?: boolean }): Promise<RotationReport> {
  const keyId = currentSecretKeyId();
  if (opts.confirmKeyId !== keyId) throw new Error(`Confirm with the new key id: --confirm ${keyId}`);
  const url = adminUrl();
  if (!url) throw new Error("DATABASE_URL_ADMIN is not set; rotation needs to reach every workspace");
  const report: RotationReport = { keyId, dryRun: !!opts.dryRun, tables: [] };
  const perTenant = new Map<string, number>();
  await withAdminClient(async (q) => {
    for (const t of TARGETS) {
      const row = { table: t.table, total: 0, alreadyCurrent: 0, resealed: 0, unreadable: [] as RotationReport["tables"][number]["unreadable"] };
      await q("BEGIN");
      try {
        const rows = await q<{ id: string; tenant_id: string; blob: string }>(`SELECT id, tenant_id, ${t.column} AS blob FROM ${t.table} FOR UPDATE`);
        row.total = rows.length;
        for (const r of rows) {
          let next: string | null;
          try {
            next = resealSecret(r.blob, { tenantId: r.tenant_id, connectionId: r.id });
          } catch {
            row.unreadable.push({ tenantId: r.tenant_id, id: r.id, keyId: secretKeyIdOf(r.blob) });
            continue;
          }
          if (next === null) {
            row.alreadyCurrent++;
            continue;
          }
          if (!opts.dryRun) {
            await q(`UPDATE ${t.table} SET ${t.column} = $1${t.alsoSet ? `, ${t.alsoSet} = $3` : ""} WHERE id = $2`, t.alsoSet ? [next, r.id, keyId] : [next, r.id]);
          }
          row.resealed++;
          perTenant.set(r.tenant_id, (perTenant.get(r.tenant_id) ?? 0) + 1);
        }
        await q(opts.dryRun ? "ROLLBACK" : "COMMIT");
      } catch (err) {
        await q("ROLLBACK").catch(() => undefined);
        throw err;
      }
      report.tables.push(row);
    }
  });
  if (!opts.dryRun) {
    // One audit entry per affected workspace, through the normal hash-chained audit path.
    for (const [tenantId, count] of perTenant) {
      await withTenant(tenantId, (tx) =>
        recordAudit(tx, { tenantId, actorType: "system", actorId: "secrets-rotation", action: "secrets.rotate", target: `key:${keyId}`, tier: 4, outcome: "success", metadata: { resealed: count, keyId } }),
      );
    }
  }
  logger.info({ keyId, dryRun: report.dryRun, tables: report.tables.map((t) => ({ table: t.table, resealed: t.resealed, unreadable: t.unreadable.length })) }, "secrets rotation");
  return report;
}
