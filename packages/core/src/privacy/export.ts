import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { inOrg, MANAGERS, requireRole } from "../org/access";
import { exportTenant, type ExportBundle, type TableReader } from "./plan";

/** Hard cap per table so one export can't OOM the server; truncation is recorded, never silent. */
export const EXPORT_MAX_ROWS_PER_TABLE = 10_000;

/**
 * Executes the data-subject export (the plan in ./plan.ts) against the real database.
 * Owners and admins only. Rows are read inside the tenant's RLS context AND filtered by
 * tenant_id explicitly (belt and suspenders). Secret columns are dropped by exportTenant.
 */
export async function exportTenantData(input: { actorUserId: string; orgId: string }): Promise<ExportBundle> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "privacy.export");

    const truncated: string[] = [];
    const reader: TableReader = {
      async read(table, tenantId) {
        // Table names come from the Drizzle schema itself; validate anyway before interpolating.
        if (!/^[a-z0-9_]+$/.test(table)) throw new AppError("VALIDATION", `Refusing to export unknown table ${table}`);
        const r = await tx.raw.query(`SELECT * FROM "${table}" WHERE tenant_id = $1 LIMIT ${EXPORT_MAX_ROWS_PER_TABLE + 1}`, [tenantId]);
        const rows = r.rows as Record<string, unknown>[];
        if (rows.length > EXPORT_MAX_ROWS_PER_TABLE) {
          truncated.push(table);
          return rows.slice(0, EXPORT_MAX_ROWS_PER_TABLE);
        }
        return rows;
      },
    };

    const bundle = await exportTenant(reader, input.orgId);
    if (truncated.length) bundle.notes.push(`Truncated at ${EXPORT_MAX_ROWS_PER_TABLE} rows: ${truncated.join(", ")}. Ask support for a full dump.`);

    const rows = Object.values(bundle.tables).reduce((n, t) => n + t.length, 0);
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "privacy.export",
      tier: 1,
      outcome: "success",
      metadata: { tables: Object.keys(bundle.tables).length, rows, ...(truncated.length ? { truncated } : {}) },
    });
    return bundle;
  });
}
