import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { memoryRecords, type Tx } from "@wos/db";
import { AppError } from "../errors";
import { recordAudit } from "../audit";
import { MANAGERS, inOrg, requireRole, STAFF } from "../org/access";
import { getPack } from "../industries/packs";
import { readPackId } from "../industries/store";
import { noteBookingRecovered } from "../pilot/metrics";
import { ingestLead, type LeadRecord } from "./service";

export interface BookedVisit {
  id: string;
  serviceId: string;
  resourceId: string;
  name: string;
  phone: string;
  startsAt: string;
  endsAt: string;
  status: "booked" | "completed" | "no_show" | "late_cancel" | "cancelled";
}

type Actor = { actorUserId: string; orgId: string };

async function load(tx: Tx, scope: string): Promise<BookedVisit[]> {
  const [row] = await tx.select({ content: memoryRecords.content }).from(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, scope)));
  if (!row) return [];
  try {
    return JSON.parse(row.content) as BookedVisit[];
  } catch {
    return [];
  }
}

async function save(tx: Tx, tenantId: string, userId: string, visits: BookedVisit[]) {
  const content = JSON.stringify(visits);
  if (content.length > 2000) throw new AppError("VALIDATION", "Too many visits stored in this workspace for the current record. Proposed migration 0021 splits them into their own table.");
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, "speed:visits")));
  await tx.insert(memoryRecords).values({ tenantId, layer: "org", scopeRef: "speed:visits", content, trust: "user", createdByUser: userId });
}

/** Books a chair or bay. Overlap on the same resource is rejected. No payment is taken. */
export async function bookVisit(input: Actor & { serviceId: string; resourceId: string; name: string; phone?: string; startsAt: Date }): Promise<BookedVisit> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "speed.visit.book");
    const packId = await readPackId(tx);
    const pack = getPack(packId ?? "general");
    if (pack.flow !== "appointment") throw new AppError("CONFLICT", "This workspace is set up for jobs, not a service book.");
    const service = pack.services.find((s) => s.id === input.serviceId);
    if (!service?.durationMinutes) throw new AppError("VALIDATION", "Pick a service from the menu.");
    const starts = input.startsAt;
    const ends = new Date(starts.getTime() + service.durationMinutes * 60_000);
    const visits = await load(tx, "speed:visits");
    const clash = visits.some((v) => v.resourceId === input.resourceId && v.status === "booked" && starts < new Date(v.endsAt) && ends > new Date(v.startsAt));
    if (clash) throw new AppError("CONFLICT", "That chair or bay is already booked then.");
    const visit: BookedVisit = {
      id: randomUUID(),
      serviceId: service.id,
      resourceId: input.resourceId.slice(0, 40),
      name: input.name.trim().slice(0, 80),
      phone: (input.phone ?? "").replace(/\D/g, "").slice(-4),
      startsAt: starts.toISOString(),
      endsAt: ends.toISOString(),
      status: "booked",
    };
    await save(tx, input.orgId, input.actorUserId, [...visits, visit]);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "speed.visit.book", target: `visit:${visit.id}`, tier: 1, outcome: "success", metadata: { serviceId: service.id, minutes: service.durationMinutes } });
    return visit;
  });
}

export async function setVisitStatus(input: Actor & { visitId: string; status: BookedVisit["status"] }): Promise<void> {
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "speed.visit.status");
    const visits = await load(tx, "speed:visits");
    const visit = visits.find((v) => v.id === input.visitId);
    if (!visit) throw new AppError("NOT_FOUND", "Visit not found");
    const recovered = (visit.status === "no_show" || visit.status === "late_cancel") && input.status === "booked";
    visit.status = input.status;
    await save(tx, input.orgId, input.actorUserId, visits);
    await recordAudit(tx, { tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "speed.visit.status", target: `visit:${visit.id}`, tier: 1, outcome: "success", metadata: { status: input.status } });
    if (recovered) await noteBookingRecovered(tx, input.orgId, input.actorUserId, visit.id);
  });
}

/** Tier 0 list: who is due again, from the pack interval. Does not send. */
export async function dueForRebook(input: Actor & { now?: Date }): Promise<{ serviceId: string; name: string; days: number }[]> {
  const now = input.now ?? new Date();
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "speed.visit.due");
    const pack = getPack((await readPackId(tx)) ?? "general");
    const rules = pack.rebookEveryDays ?? [];
    const visits = (await load(tx, "speed:visits")).filter((v) => v.status === "completed");
    const due: { serviceId: string; name: string; days: number }[] = [];
    for (const rule of rules) {
      for (const v of visits.filter((x) => x.serviceId === rule.serviceId)) {
        const days = Math.floor((now.getTime() - Date.parse(v.endsAt)) / 86_400_000);
        if (days >= rule.days) due.push({ serviceId: rule.serviceId, name: v.name, days });
      }
    }
    return due;
  });
}

/** A follow-up text still goes through the same template and consent gates. */
export async function remindVisit(input: Actor & { name: string; phone: string; purpose: "rebook" | "no_show" | "late_cancel" | "review"; now?: Date }): Promise<LeadRecord> {
  return ingestLead({ ...input, source: "sms", externalKey: `remind:${input.purpose}:${input.phone}:${input.now?.toISOString() ?? Date.now()}`, purpose: input.purpose });
}
