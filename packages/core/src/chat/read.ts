import { sql } from "drizzle-orm";
import { approvalRequests, invoices, memoryRecords, tasks, type Tx } from "@wos/db";

/** Read-only counts for this tenant. No message bodies, no addresses. */
export async function workspaceSnapshot(tx: Tx, _tenantId: string): Promise<string> {
  const [leads] = await tx.select({ n: sql<number>`count(*)::int` }).from(memoryRecords).where(sql`${memoryRecords.scopeRef} LIKE 'speed:lead:%'`);
  const [jobs] = await tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(sql`${tasks.state} NOT IN ('COMPLETED', 'FAILED')`);
  const [bills] = await tx.select({ n: sql<number>`count(*)::int` }).from(invoices).where(sql`${invoices.status} = 'open'`);
  const [oks] = await tx.select({ n: sql<number>`count(*)::int` }).from(approvalRequests).where(sql`${approvalRequests.status} = 'pending'`);
  return `Read-only: ${leads?.n ?? 0} timed leads, ${jobs?.n ?? 0} open jobs, ${bills?.n ?? 0} open invoices, ${oks?.n ?? 0} approvals waiting. Nothing was changed.`;
}
