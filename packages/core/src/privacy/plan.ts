import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as dbSchema from "@wos/db";
import { ERASURE_BLOCKERS, ERASURE_ORDER, ERASURE_PRE_STEPS, TABLE_POLICY } from "./registry";

export interface TenantTable { name: string; table: PgTable }

/** Every tenant-scoped table in the real schema (has tenant_id), plus nothing else. */
export function tenantTables(): TenantTable[] {
  const out: TenantTable[] = [];
  for (const v of Object.values(dbSchema)) {
    if (!is(v, PgTable)) continue;
    const cfg = getTableConfig(v as PgTable);
    if (cfg.columns.some((c) => c.name === "tenant_id")) out.push({ name: cfg.name, table: v as PgTable });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Tenant tables with no policy: must always be empty (guarded by a test). */
export function unclassifiedTables(): string[] {
  return tenantTables().map((t) => t.name).filter((n) => !(n in TABLE_POLICY));
}

/** Fixed, migration-verified delete order (see registry). */
export function erasureOrder(): string[] {
  return [...ERASURE_ORDER];
}

export interface ErasurePlan {
  tenantId: string;
  requestedBy: string;
  /** Deletion is a Tier 4 action: a second, different owner must approve. Never auto-executed. */
  approvalTier: 4;
  status: "plan_only_not_executed";
  preSteps: string[];
  deleteOrder: string[];
  /** Open findings that stop this plan from being runnable today. */
  blockers: string[];
  /** The organizations row is anonymized, never deleted: deleting it cascades into retained tables. */
  organizationRow: "anonymize_do_not_delete";
  retained: { table: string; reason: string; legalReview?: "pending" }[];
  /** Always true here: run a full export first so the owner can keep a copy. */
  exportFirst: true;
  notes: string[];
}

export function planErasure(tenantId: string, requestedBy: string): ErasurePlan {
  const retained = tenantTables()
    .filter((t) => TABLE_POLICY[t.name]?.erase === "retain")
    .map((t) => ({ table: t.name, reason: TABLE_POLICY[t.name]!.reason ?? "retained", legalReview: TABLE_POLICY[t.name]!.legalReview }));
  return {
    tenantId, requestedBy, approvalTier: 4, status: "plan_only_not_executed", preSteps: [...ERASURE_PRE_STEPS], deleteOrder: erasureOrder(), blockers: [...ERASURE_BLOCKERS], organizationRow: "anonymize_do_not_delete", retained, exportFirst: true,
    notes: [
      "Nothing has been deleted. Executing this plan needs a Tier 4 approval from a second owner.",
      "Retained tables are an owner/legal decision (legalReview pending). Review before launch.",
      "Delete order is checked against the migration SQL in tests, but has never been run against a real database.",
      "Tenant data in backups and in third-party systems (Gmail, Stripe, Twilio) is not covered by this plan.",
    ],
  };
}

/** Minimal read interface so export is testable without a database. */
export interface TableReader { read(table: string, tenantId: string): Promise<Record<string, unknown>[]> }

export interface ExportBundle {
  tenantId: string;
  generatedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
  omittedColumns: Record<string, string[]>;
  notes: string[];
}

export async function exportTenant(reader: TableReader, tenantId: string, now: Date = new Date()): Promise<ExportBundle> {
  const tables: ExportBundle["tables"] = {};
  const omittedColumns: ExportBundle["omittedColumns"] = {};
  for (const t of tenantTables()) {
    const secret = new Set(TABLE_POLICY[t.name]?.secretColumns ?? []);
    const rows = await reader.read(t.name, tenantId);
    tables[t.name] = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !secret.has(k) && !secret.has(snake(k)))));
    if (secret.size) omittedColumns[t.name] = [...secret];
  }
  return {
    tenantId, generatedAt: now.toISOString(), tables, omittedColumns,
    notes: ["Credentials and tokens are omitted by design.", "Mail held in Gmail and payment data held in Stripe/Twilio stay in those systems and are not part of this file."],
  };
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
