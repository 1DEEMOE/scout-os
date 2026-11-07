import { desc, like } from "drizzle-orm";
import { auditEvents } from "@wos/db";
import { ANY_ROLE, inOrg, requireRole } from "../org/access";
import { listConnectionsSafe } from "./connections";

export type HandoffLane = "calendar" | "crm" | "accounting";
export type HandoffState = "not_connected" | "ok" | "failing" | "recovered";

export interface HandoffStatus {
  lane: HandoffLane;
  label: string;
  state: HandoffState;
  /** Plain sentence for the settings page. */
  detail: string;
  openFailures: number;
}

const LANES: Array<{ lane: HandoffLane; label: string; providers: string[] }> = [
  { lane: "calendar", label: "Calendar", providers: ["google", "calendar"] },
  { lane: "crm", label: "CRM", providers: ["hubspot", "crm"] },
  { lane: "accounting", label: "Accounting", providers: ["quickbooks", "stripe", "accounting"] },
];

function laneOf(integration: string): HandoffLane | null {
  const name = integration.toLowerCase();
  if (!name) return null;
  for (const lane of LANES) if (lane.providers.some((p) => name.includes(p))) return lane.lane;
  return null;
}

/**
 * Calendar, CRM, and accounting handoffs. Derived from connections and the
 * audit log (open and resolved dead letters). No new table is read.
 */
export async function handoffReliability(input: { actorUserId: string; orgId: string }): Promise<HandoffStatus[]> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "integration.list");
    const connections = await listConnectionsSafe(tx);
    const rows = await tx.select().from(auditEvents).where(like(auditEvents.action, "ops.dead_letter%")).orderBy(desc(auditEvents.seq)).limit(500);
    const resolved = new Set(rows.filter((r) => r.action === "ops.dead_letter.resolved").map((r) => String(r.metadata.deadLetterId ?? "")));
    const open = rows.filter((r) => r.action === "ops.dead_letter" && !resolved.has(r.id));
    const recovered = rows.filter((r) => r.action === "ops.dead_letter.resolved");
    return LANES.map((lane) => {
      const connected = connections.some((c) => c.status === "active" && lane.providers.some((p) => c.provider.toLowerCase().includes(p)));
      const failing = open.filter((r) => laneOf(String(r.metadata.integration ?? "")) === lane.lane);
      const fixed = recovered.filter((r) => laneOf(String(r.metadata.integration ?? "")) === lane.lane);
      if (failing.length) {
        return { lane: lane.lane, label: lane.label, state: "failing" as const, openFailures: failing.length, detail: `${failing.length} handoff${failing.length === 1 ? "" : "s"} failed and can be replayed from Recovery. Nothing is sent again by itself.` };
      }
      if (fixed.length) {
        return { lane: lane.lane, label: lane.label, state: "recovered" as const, openFailures: 0, detail: "A failed handoff was replayed and marked recovered." };
      }
      if (!connected) {
        return { lane: lane.lane, label: lane.label, state: "not_connected" as const, openFailures: 0, detail: "Not connected. The pack only suggests this. Connecting it does not send email, texts, or payments." };
      }
      return { lane: lane.lane, label: lane.label, state: "ok" as const, openFailures: 0, detail: "Connected. No failed handoff is waiting." };
    });
  });
}
