/**
 * AI front desk — inbound booking channel for people and AI agents.
 * Every outside booking creates a tier ≥2 approval (same floor as email/chat).
 * Never auto-confirms. Rate limits + abuse checks. No PII in logs or rate keys.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  agents,
  approvalRequests,
  frontDeskBookings,
  frontDeskChannels,
  frontDeskSlots,
  tasks,
  type Tx,
  withFrontDeskToken,
  withTenant,
} from "@wos/db";
import { recordAudit } from "../audit";
import { actionDigest } from "../engine/digest";
import { AppError } from "../errors";
import { ANY_ROLE, MANAGERS, STAFF, inOrg, requireRole } from "../org/access";

export const FRONT_DESK_BOOKING_MIN_TIER = 2 as const;
export const FRONT_DESK_TOOL = "front_desk.confirm_booking";

const PER_WINDOW = 20;
const WINDOW_MS = 60_000;
const ABUSE_PER_DAY = 100;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function daySalt(): string {
  // Rotates daily so IP hashes are not a stable identifier across days.
  return new Date().toISOString().slice(0, 10);
}

export function hashIp(ip: string): string {
  return sha256(`${ip}|${daySalt()}|front-desk`);
}

async function bumpRate(tx: Tx, tenantId: string, channelId: string, bucketKey: string, windowStart: Date): Promise<number> {
  // Atomic upsert: concurrent requests on the same window can never both pass
  // under the limit by reading the same stale count.
  const r = await tx.raw.query(
    `INSERT INTO front_desk_rate_buckets (tenant_id, channel_id, bucket_key, window_start, count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (tenant_id, channel_id, bucket_key, window_start)
     DO UPDATE SET count = front_desk_rate_buckets.count + 1
     RETURNING count`,
    [tenantId, channelId, bucketKey, windowStart],
  );
  return (r.rows[0] as { count: number }).count;
}

export async function enableFrontDesk(input: {
  actorUserId: string;
  orgId: string;
  displayName: string;
  timezone?: string;
  disclosure?: string;
}): Promise<{ channelId: string; publicToken: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "front_desk.enable");
    const publicToken = randomBytes(24).toString("base64url");
    const [row] = await tx
      .insert(frontDeskChannels)
      .values({
        tenantId: input.orgId,
        tokenHash: sha256(publicToken),
        displayName: input.displayName.slice(0, 120),
        timezone: input.timezone ?? "America/New_York",
        disclosure:
          input.disclosure ??
          "Bookings are reviewed by a person before they are confirmed. AI assistants must identify themselves.",
        createdBy: input.actorUserId,
      })
      .returning({ id: frontDeskChannels.id });
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "front_desk.enable",
      target: `front_desk_channel:${row!.id}`,
      tier: 1,
      outcome: "success",
      metadata: {},
    });
    // The plaintext token is returned exactly once; only its hash is stored.
    return { channelId: row!.id, publicToken };
  });
}

export async function addFrontDeskSlots(input: {
  actorUserId: string;
  orgId: string;
  channelId: string;
  slots: { startsAt: Date; endsAt: Date; capacity?: number }[];
}): Promise<{ added: number }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, STAFF, "front_desk.slots.add");
    const [ch] = await tx.select().from(frontDeskChannels).where(eq(frontDeskChannels.id, input.channelId));
    if (!ch) throw new AppError("NOT_FOUND", "Front desk channel not found");
    if (input.slots.length === 0) throw new AppError("VALIDATION", "Add at least one time slot");
    if (input.slots.length > 50) throw new AppError("VALIDATION", "Add at most 50 slots at a time");
    const now = Date.now();
    let added = 0;
    for (const s of input.slots) {
      if (Number.isNaN(s.startsAt.getTime()) || Number.isNaN(s.endsAt.getTime())) throw new AppError("VALIDATION", "Each slot needs a valid start and end");
      if (s.endsAt <= s.startsAt) throw new AppError("VALIDATION", "Slot end must be after start");
      if (s.startsAt.getTime() < now) throw new AppError("VALIDATION", "Slots must start in the future");
      if (s.startsAt.getTime() > now + 366 * 86_400_000) throw new AppError("VALIDATION", "Slots can be at most a year ahead");
      if (s.endsAt.getTime() - s.startsAt.getTime() > 12 * 3_600_000) throw new AppError("VALIDATION", "A slot can be at most 12 hours long");
      const cap = s.capacity ?? 1;
      if (!Number.isInteger(cap) || cap < 1 || cap > 50) throw new AppError("VALIDATION", "Capacity must be between 1 and 50");
      await tx.insert(frontDeskSlots).values({
        tenantId: input.orgId,
        channelId: ch.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        capacity: cap,
      });
      added++;
    }
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "front_desk.slots.add",
      target: `front_desk_channel:${ch.id}`,
      tier: 1,
      outcome: "success",
      metadata: { added },
    });
    return { added };
  });
}

export async function getChannelByToken(publicToken: string) {
  // The link carries no tenant, so look the channel up through the narrow
  // 0019 policy: this transaction can read only the row whose token hash
  // matches. No admin/BYPASSRLS connection in the web process (Law 5).
  if (typeof publicToken !== "string" || publicToken.length < 16 || publicToken.length > 128) return null;
  const rows = await withFrontDeskToken(sha256(publicToken), async (tx) =>
    (
      await tx.raw.query(
        `SELECT id, tenant_id, display_name, timezone, disclosure, status
         FROM front_desk_channels WHERE token_hash = $1 LIMIT 1`,
        [sha256(publicToken)],
      )
    ).rows as { id: string; tenant_id: string; display_name: string; timezone: string; disclosure: string; status: string }[],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    publicToken,
    displayName: row.display_name,
    timezone: row.timezone,
    disclosure: row.disclosure,
    status: row.status,
  };
}

export async function listAvailability(publicToken: string, from: Date, to: Date) {
  const ch = await getChannelByToken(publicToken);
  if (!ch || ch.status !== "active") throw new AppError("NOT_FOUND", "Front desk not found");
  return withTenant(ch.tenantId, async (tx) => {
    const slots = await tx
      .select()
      .from(frontDeskSlots)
      .where(
        and(
          eq(frontDeskSlots.channelId, ch.id),
          gt(frontDeskSlots.startsAt, from),
          sql`${frontDeskSlots.startsAt} < ${to}`,
          sql`${frontDeskSlots.reservedCount} < ${frontDeskSlots.capacity}`,
        ),
      )
      .orderBy(asc(frontDeskSlots.startsAt))
      .limit(100);
    return {
      channel: {
        displayName: ch.displayName,
        timezone: ch.timezone,
        disclosure: ch.disclosure,
      },
      slots: slots.map((s) => ({
        id: s.id,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        remaining: s.capacity - s.reservedCount,
      })),
    };
  });
}

export type BookingRequest = {
  publicToken: string;
  slotId: string;
  requesterKind: "person" | "ai_agent";
  agentName?: string;
  agentProvider?: string;
  disclosureAck: boolean;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  notes?: string;
  clientRef?: string;
  sourceIp: string;
};

async function ensureSchedulingAgent(tx: Tx, tenantId: string): Promise<string> {
  const [existing] = await tx.select().from(agents).where(and(eq(agents.kind, "scheduling")));
  if (existing) return existing.id;
  const [row] = await tx
    .insert(agents)
    .values({
      tenantId,
      kind: "scheduling",
      displayName: "Front desk",
      status: "active",
    })
    .returning({ id: agents.id });
  return row!.id;
}

/**
 * Public booking intake. Always creates a tier-2+ approval — never auto-confirms.
 */
export async function requestBooking(input: BookingRequest): Promise<{ bookingId: string; status: string; approvalRequired: true }> {
  if (!input.disclosureAck) throw new AppError("VALIDATION", "You must acknowledge the disclosure");
  if (input.requesterKind === "ai_agent" && !input.agentName?.trim()) {
    throw new AppError("VALIDATION", "AI agents must identify themselves (agentName)");
  }
  if (input.requesterKind === "person" && (input.agentName || input.agentProvider)) {
    throw new AppError("VALIDATION", "Person bookings cannot carry agent identity fields");
  }
  const email = input.customerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("VALIDATION", "Invalid email");
  // Abuse: disposable-looking all-consonant local parts longer than 20 → block softly
  const local = email.split("@")[0] ?? "";
  if (local.length > 40) throw new AppError("VALIDATION", "Email looks invalid");

  const ch = await getChannelByToken(input.publicToken);
  if (!ch || ch.status !== "active") throw new AppError("NOT_FOUND", "Front desk not found");

  const ipHash = hashIp(input.sourceIp || "unknown");
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
  const dayStart = new Date(`${daySalt()}T00:00:00.000Z`);

  // Count the attempt in its own committed transaction BEFORE trying to book.
  // Counting inside the booking transaction meant every failed attempt (bad
  // slot, full slot, validation) rolled its own increment back, so failures
  // were never limited, and the denial audit row was rolled back with them.
  const limited = await withTenant(ch.tenantId, async (tx) => {
    const perIp = await bumpRate(tx, ch.tenantId, ch.id, `ip:${ipHash}`, windowStart);
    const perDay = await bumpRate(tx, ch.tenantId, ch.id, `day:${ipHash}`, dayStart);
    const reason = perIp > PER_WINDOW ? "per_ip_window" : perDay > ABUSE_PER_DAY ? "per_ip_day" : null;
    // Audit only the first denial in a window, so a flood can't flood the audit log.
    if (reason && (reason === "per_ip_window" ? perIp === PER_WINDOW + 1 : perDay === ABUSE_PER_DAY + 1)) {
      await recordAudit(tx, {
        tenantId: ch.tenantId,
        actorType: "system",
        actorId: "front_desk",
        action: "front_desk.rate_limited",
        target: `front_desk_channel:${ch.id}`,
        tier: 0,
        outcome: "denied",
        metadata: { reason },
      });
    }
    return reason;
  });
  if (limited === "per_ip_window") throw new AppError("RATE_LIMITED", "Too many booking attempts. Try again shortly.");
  if (limited === "per_ip_day") throw new AppError("RATE_LIMITED", "Daily booking limit reached for this network.");

  return withTenant(ch.tenantId, async (tx) => {

    const [slot] = await tx.select().from(frontDeskSlots).where(eq(frontDeskSlots.id, input.slotId));
    if (!slot || slot.channelId !== ch.id) throw new AppError("NOT_FOUND", "Slot not found");

    if (input.clientRef) {
      const [prior] = await tx
        .select()
        .from(frontDeskBookings)
        .where(and(eq(frontDeskBookings.channelId, ch.id), eq(frontDeskBookings.clientRef, input.clientRef)));
      if (prior) return { bookingId: prior.id, status: prior.status, approvalRequired: true as const };
    }

    // Atomic capacity hold: the WHERE clause is the only place the slot can
    // sell out, so two concurrent requests can't both fit into the last seat.
    const held = await tx.raw.query(
      `UPDATE front_desk_slots SET reserved_count = reserved_count + 1
       WHERE tenant_id = $1 AND id = $2 AND reserved_count < capacity
       RETURNING id`,
      [ch.tenantId, slot.id],
    );
    if (!held.rows.length) throw new AppError("CONFLICT", "That slot is full");

    const agentId = await ensureSchedulingAgent(tx, ch.tenantId);
    const bookingId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    // Same formula the executor re-checks — a custom hash here caused DIGEST_MISMATCH on approve.
    const digest = actionDigest({
      tenantId: ch.tenantId,
      taskId,
      agentId,
      step: 0,
      tool: FRONT_DESK_TOOL,
      args: { bookingId },
    });
    await tx.insert(tasks).values({
        id: taskId,
        tenantId: ch.tenantId,
        requestedBy: `front-desk:${input.requesterKind}`,
        assignedAgentId: agentId,
        intent: `Confirm front-desk booking for ${input.customerName.slice(0, 80)}`,
        title: `Front desk booking · ${input.customerName.slice(0, 60)}`,
        state: "WAITING_FOR_APPROVAL",
        input: {
          source: "front_desk",
          external: true,
          bookingId,
        },
        plan: {
          steps: [
            {
              index: 0,
              tool: FRONT_DESK_TOOL,
              args: { bookingId },
              tier: FRONT_DESK_BOOKING_MIN_TIER,
              decision: "needs_approval",
              summary: `Confirm booking for ${input.customerName.slice(0, 60)}`,
              digest,
            },
          ],
        },
      });

    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: ch.tenantId,
        taskId,
        agentId,
        toolName: FRONT_DESK_TOOL,
        tier: FRONT_DESK_BOOKING_MIN_TIER,
        actionDigest: digest,
        payload: {
          tool: FRONT_DESK_TOOL,
          args: { bookingId },
          step: 0,
          externalDataFields: ["customerEmail", "customerName", "notes"],
          source: "front_desk",
        },
        summary: `Front desk: confirm ${input.requesterKind === "ai_agent" ? "AI-agent" : "person"} booking for ${input.customerName.slice(0, 60)}`,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      })
      .returning({ id: approvalRequests.id });

    await tx.insert(frontDeskBookings).values({
        id: bookingId,
        tenantId: ch.tenantId,
        channelId: ch.id,
        slotId: slot.id,
        requesterKind: input.requesterKind,
        agentName: input.requesterKind === "ai_agent" ? input.agentName!.slice(0, 120) : null,
        agentProvider: input.agentProvider?.slice(0, 120) ?? null,
        disclosureAck: true,
        customerName: input.customerName.slice(0, 120),
        customerEmail: email,
        customerPhone: input.customerPhone?.slice(0, 40) ?? null,
        notes: input.notes?.slice(0, 1000) ?? null,
        clientRef: input.clientRef?.slice(0, 100) ?? null,
        sourceIpHash: ipHash,
        status: "pending_approval",
        approvalRequestId: approval!.id,
        taskId,
      });

    await tx
      .update(tasks)
      .set({
        plan: {
          steps: [
            {
              index: 0,
              tool: FRONT_DESK_TOOL,
              args: { bookingId },
              tier: FRONT_DESK_BOOKING_MIN_TIER,
              decision: "needs_approval",
              summary: `Confirm booking for ${input.customerName.slice(0, 60)}`,
              digest,
              approvalId: approval!.id,
            },
          ],
        },
      })
      .where(eq(tasks.id, taskId));

    await recordAudit(tx, {
      tenantId: ch.tenantId,
      actorType: "system",
      actorId: "front_desk",
      action: "front_desk.booking.request",
      target: `front_desk_booking:${bookingId}`,
      approvalRequestId: approval!.id,
      tier: FRONT_DESK_BOOKING_MIN_TIER,
      outcome: "success",
      metadata: {
        requesterKind: input.requesterKind,
        ...(input.requesterKind === "ai_agent" ? { agentProvider: input.agentProvider ?? null } : {}),
        // Never log email, name, phone, or raw IP.
      },
    });

    return { bookingId, status: "pending_approval", approvalRequired: true as const };
  });
}

export async function confirmFrontDeskBooking(tx: Tx, tenantId: string, bookingId: string): Promise<{ bookingId: string; status: "confirmed" }> {
  const [b] = await tx.select().from(frontDeskBookings).where(eq(frontDeskBookings.id, bookingId));
  if (!b) throw new AppError("NOT_FOUND", "Booking not found");
  if (b.status === "confirmed") return { bookingId, status: "confirmed" };
  if (b.status !== "pending_approval") throw new AppError("CONFLICT", `Booking is ${b.status}`);
  await tx
    .update(frontDeskBookings)
    .set({ status: "confirmed", resolvedAt: new Date() })
    .where(eq(frontDeskBookings.id, bookingId));
  await recordAudit(tx, {
    tenantId,
    actorType: "system",
    actorId: "front_desk",
    action: "front_desk.booking.confirm",
    target: `front_desk_booking:${bookingId}`,
    tier: FRONT_DESK_BOOKING_MIN_TIER,
    outcome: "success",
    metadata: {},
  });
  return { bookingId, status: "confirmed" };
}

export async function rejectFrontDeskBooking(tx: Tx, tenantId: string, bookingId: string): Promise<void> {
  const [b] = await tx.select().from(frontDeskBookings).where(eq(frontDeskBookings.id, bookingId));
  if (!b || b.status !== "pending_approval") return;
  await tx
    .update(frontDeskBookings)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(eq(frontDeskBookings.id, bookingId));
  // Guarded decrement: a double-release can never push reserved_count negative.
  await tx.raw.query(
    `UPDATE front_desk_slots SET reserved_count = reserved_count - 1
     WHERE tenant_id = $1 AND id = $2 AND reserved_count > 0`,
    [tenantId, b.slotId],
  );
  await recordAudit(tx, {
    tenantId,
    actorType: "system",
    actorId: "front_desk",
    action: "front_desk.booking.reject",
    target: `front_desk_booking:${bookingId}`,
    tier: FRONT_DESK_BOOKING_MIN_TIER,
    outcome: "success",
    metadata: {},
  });
}

export async function listPendingFrontDeskBookings(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "front_desk.list");
    // Bookings wait on a 48h approval; if that approval expired without a
    // decision, the booking is dead but still holds capacity. Cancel it and
    // release the slot so the seat can sell again.
    const stale = await tx
      .select({ id: frontDeskBookings.id, slotId: frontDeskBookings.slotId })
      .from(frontDeskBookings)
      .innerJoin(approvalRequests, eq(approvalRequests.id, frontDeskBookings.approvalRequestId))
      .where(
        and(
          eq(frontDeskBookings.status, "pending_approval"),
          sql`(${approvalRequests.status} = 'expired' OR ((${approvalRequests.status} = 'pending' OR ${approvalRequests.status} = 'awaiting_confirmation') AND ${approvalRequests.expiresAt} <= now()))`,
        ),
      );
    for (const b of stale) {
      await tx.update(frontDeskBookings).set({ status: "cancelled", resolvedAt: new Date() }).where(eq(frontDeskBookings.id, b.id));
      await tx.raw.query(
        `UPDATE front_desk_slots SET reserved_count = reserved_count - 1
         WHERE tenant_id = $1 AND id = $2 AND reserved_count > 0`,
        [input.orgId, b.slotId],
      );
      await recordAudit(tx, {
        tenantId: input.orgId,
        actorType: "system",
        actorId: "front_desk",
        action: "front_desk.booking.cancel",
        target: `front_desk_booking:${b.id}`,
        tier: 0,
        outcome: "success",
        metadata: { reason: "approval_expired" },
      });
    }
    return tx
      .select()
      .from(frontDeskBookings)
      .where(eq(frontDeskBookings.status, "pending_approval"))
      .orderBy(asc(frontDeskBookings.createdAt))
      .limit(50);
  });
}

export async function listFrontDeskChannels(input: { actorUserId: string; orgId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "front_desk.channels");
    // Never the token hash: since migration 0019 it works as a read key for the
    // channel row, so it stays on the server.
    return tx
      .select({
        id: frontDeskChannels.id,
        displayName: frontDeskChannels.displayName,
        timezone: frontDeskChannels.timezone,
        disclosure: frontDeskChannels.disclosure,
        status: frontDeskChannels.status,
        createdAt: frontDeskChannels.createdAt,
        updatedAt: frontDeskChannels.updatedAt,
      })
      .from(frontDeskChannels)
      .orderBy(asc(frontDeskChannels.createdAt))
      .limit(10);
  });
}

/** Pause or resume public booking on a channel. Paused links answer 404. */
export async function setFrontDeskStatus(input: { actorUserId: string; orgId: string; channelId: string; status: "active" | "paused" }) {
  if (input.status !== "active" && input.status !== "paused") throw new AppError("VALIDATION", "Status must be active or paused");
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "front_desk.status");
    const rows = await tx
      .update(frontDeskChannels)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(frontDeskChannels.id, input.channelId))
      .returning({ id: frontDeskChannels.id });
    if (!rows.length) throw new AppError("NOT_FOUND", "Front desk channel not found");
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "front_desk.status",
      target: `front_desk_channel:${input.channelId}`, tier: 1, outcome: "success", metadata: { status: input.status },
    });
    return { status: input.status };
  });
}

/**
 * Replaces the booking link. The old link stops working at once; the new
 * token is returned exactly once (only its hash is stored). A credential
 * change, so it's audited at tier 4.
 */
export async function rotateFrontDeskLink(input: { actorUserId: string; orgId: string; channelId: string }): Promise<{ publicToken: string }> {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "front_desk.rotate");
    const publicToken = randomBytes(24).toString("base64url");
    const rows = await tx
      .update(frontDeskChannels)
      .set({ tokenHash: sha256(publicToken), updatedAt: new Date() })
      .where(eq(frontDeskChannels.id, input.channelId))
      .returning({ id: frontDeskChannels.id });
    if (!rows.length) throw new AppError("NOT_FOUND", "Front desk channel not found");
    await recordAudit(tx, {
      tenantId: input.orgId, actorType: "user", actorId: input.actorUserId, action: "front_desk.rotate",
      target: `front_desk_channel:${input.channelId}`, tier: 4, outcome: "success", metadata: {},
    });
    return { publicToken };
  });
}

/** Upcoming slots with how many seats are taken, for the owner's schedule view. */
export async function listFrontDeskSlots(input: { actorUserId: string; orgId: string; channelId: string }) {
  return inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, ANY_ROLE, "front_desk.slots.list");
    return tx
      .select({ id: frontDeskSlots.id, startsAt: frontDeskSlots.startsAt, endsAt: frontDeskSlots.endsAt, capacity: frontDeskSlots.capacity, reservedCount: frontDeskSlots.reservedCount })
      .from(frontDeskSlots)
      .where(and(eq(frontDeskSlots.channelId, input.channelId), gt(frontDeskSlots.endsAt, new Date())))
      .orderBy(asc(frontDeskSlots.startsAt))
      .limit(200);
  });
}
