import { and, desc, eq } from "drizzle-orm";
import { adminQuery, frontDeskChannels, memoryRecords, organizations, type Tx } from "@wos/db";
import { recordAudit } from "../audit";
import { AppError } from "../errors";
import { logger } from "../logger";
import { inOrg, MANAGERS, requireRole } from "../org/access";
import { enableFrontDesk, rotateFrontDeskLink } from "../front-desk/service";
import {
  channelReadiness,
  ManagedNumberError,
  numberProvisionerFromEnv,
  provisionManagedNumber,
  proposeNumbers,
  recordA2pStatus,
  releaseManagedNumber,
  repointManagedNumber,
  type A2pStatus,
  type ManagedNumberRecord,
  type ManagedNumberStore,
  type NumberProvisioner,
  type ProvisionProposal,
} from "./managed-number";

/**
 * Wires the managed-number core (./managed-number.ts) into the app: role gates, audit,
 * persistence, and the front-desk token lifecycle.
 *
 * Persistence is interim: records live in memory_records (scope "speed:managed-number")
 * until proposed migration 0024_managed_numbers.sql is reviewed and applied — the same
 * interim pattern as the industry-pack store. The cross-tenant getByPhone conflict check
 * needs DATABASE_URL_ADMIN; without it a purchase fails closed (never risks repointing
 * another workspace's number).
 *
 * Token lifecycle: webhook URLs carry the front-desk public token, whose plaintext exists
 * only at enable/rotate time. Provisioning therefore issues a fresh link BEFORE buying
 * (the old booking link stops working — the UI warns before the owner confirms), and
 * every later rotate re-points the number (see repointManagedNumberAfterRotate below).
 */

const SCOPE = "speed:managed-number";

function parseRecord(content: string): ManagedNumberRecord | null {
  try {
    const v = JSON.parse(content) as ManagedNumberRecord;
    return v && typeof v.tenantId === "string" && typeof v.phone === "string" ? v : null;
  } catch {
    return null;
  }
}

async function putRecord(tx: Tx, tenantId: string, record: ManagedNumberRecord): Promise<void> {
  const content = JSON.stringify(record);
  if (content.length > 2000) throw new AppError("VALIDATION", "Managed-number record is too long to store.");
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, SCOPE)));
  await tx.insert(memoryRecords).values({ tenantId, layer: "org", scopeRef: SCOPE, content, trust: "verified", createdByUser: "system:managed-number" });
}

/** Durable store backed by memory_records. Cross-tenant lookups go through the admin pool. */
export function dbManagedNumberStore(): ManagedNumberStore {
  return {
    async get(tenantId) {
      return inOrg(tenantId, async (tx) => {
        const rows = await tx
          .select({ content: memoryRecords.content })
          .from(memoryRecords)
          .where(and(eq(memoryRecords.tenantId, tenantId), eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, SCOPE)))
          .orderBy(desc(memoryRecords.createdAt))
          .limit(1);
        return rows[0] ? parseRecord(rows[0].content) : null;
      });
    },
    async getByPhone(phone) {
      // Cross-tenant: the memory_records row lives under another workspace's RLS, so this
      // needs the admin pool. Failing closed is deliberate: buying without this check could
      // repoint a number that belongs to a different workspace.
      let rows: { content: string }[];
      try {
        rows = await adminQuery<{ content: string }>(`SELECT content FROM memory_records WHERE layer = 'org' AND scope_ref = $1`, [SCOPE]);
      } catch {
        throw new ManagedNumberError(
          "provider_error",
          "Cannot verify number ownership across workspaces right now (DATABASE_URL_ADMIN not set). No purchase was made.",
        );
      }
      for (const r of rows) {
        const rec = parseRecord(r.content);
        if (rec?.phone === phone) return rec;
      }
      return null;
    },
    async put(record) {
      await inOrg(record.tenantId, (tx) => putRecord(tx, record.tenantId, record));
    },
  };
}

let cachedPort: NumberProvisioner | null | undefined;

/** Process-wide provisioner: the mock must be a singleton or its owned-number state is lost between calls. */
function provisioner(): NumberProvisioner | null {
  if (cachedPort === undefined) cachedPort = numberProvisionerFromEnv();
  return cachedPort;
}

/** Tests only: drop the cached provisioner (e.g. after changing env). */
export function resetManagedNumberProvisionerForTests(): void {
  cachedPort = undefined;
}

/** Tests only: the process-wide provisioner, so assertions see the same mock state the service used. */
export function managedNumberProvisionerForTests(): NumberProvisioner | null {
  return provisioner();
}

function provisionerOrThrow(): NumberProvisioner {
  const port = provisioner();
  if (!port) {
    throw new AppError("VALIDATION", "Managed numbers are off on this platform (needs Twilio credentials + WOS_MANAGED_NUMBERS=1, or mock mode).");
  }
  return port;
}

function publicBaseFromEnv(): string {
  const base = process.env.BETTER_AUTH_URL?.trim();
  if (!base) throw new AppError("VALIDATION", "BETTER_AUTH_URL must be the public https URL before a number can be pointed at it.");
  return base;
}

export interface ManagedNumberStatus {
  /** Whether the platform can provision numbers at all (mock or live-enabled). */
  enabled: boolean;
  record: ManagedNumberRecord | null;
  readiness: { voice: boolean; textBack: boolean; reason?: string };
}

/** Managers can see the workspace's number state. */
export async function managedNumberStatus(input: { actorUserId: string; orgId: string }): Promise<ManagedNumberStatus> {
  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "speed.managed_number.read"));
  const record = await dbManagedNumberStore().get(input.orgId);
  return { enabled: provisioner() !== null, record, readiness: channelReadiness(record) };
}

/** Search only — nothing is bought. Returns options plus the warnings the owner must read. */
export async function proposeManagedNumbers(input: { actorUserId: string; orgId: string; areaCode: string }): Promise<ProvisionProposal> {
  const port = provisionerOrThrow();
  await inOrg(input.orgId, async (tx) => {
    await requireRole(tx, input.orgId, input.actorUserId, MANAGERS, "speed.managed_number.propose");
  });
  return proposeNumbers(port, input.areaCode);
}

/**
 * Buys (or reconciles after a crash) the workspace's number. Tier 3 money action: the
 * signed-in owner IS the named human approval (requireApproval rejects system actors).
 * Issues a fresh front-desk link first so the number's webhooks always carry a live token;
 * returns that link's plaintext token once so the UI can show it.
 */
export async function provisionManagedNumberForOrg(input: {
  actorUserId: string;
  orgId: string;
  phone: string;
}): Promise<{ record: ManagedNumberRecord; publicToken: string | null; mock: boolean }> {
  const port = provisionerOrThrow();
  const store = dbManagedNumberStore();
  const publicBase = publicBaseFromEnv();

  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, ["owner"], "speed.managed_number.provision"));

  // Idempotent: an already-active number means the webhooks carry a still-live token.
  // Rotating here would break that link for nothing.
  const existing = await store.get(input.orgId);
  if (existing?.status === "active") return { record: existing, publicToken: null, mock: port.mock };

  const name = await orgName(input.orgId);

  // Fresh link first: if the buy then fails, the damage is a rotated booking link
  // (recoverable by sharing the new one), never a number pointing at a dead token.
  const [channel] = await inOrg(input.orgId, async (tx) => tx.select({ id: frontDeskChannels.id }).from(frontDeskChannels).limit(1));
  const link = channel
    ? await rotateFrontDeskLink({ actorUserId: input.actorUserId, orgId: input.orgId, channelId: channel.id })
    : await enableFrontDesk({ actorUserId: input.actorUserId, orgId: input.orgId, displayName: name });

  const record = await provisionManagedNumber({
    port,
    store,
    tenantId: input.orgId,
    phone: input.phone,
    businessName: name,
    publicBase,
    publicToken: link.publicToken,
    approval: { approvedBy: input.actorUserId, tier: 3 },
  });

  await inOrg(input.orgId, async (tx) => {
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "speed.managed_number.provision",
      target: `phone:***${record.phone.slice(-4)}`,
      tier: 3,
      outcome: "success",
      metadata: { mock: record.mock, status: record.status },
    });
  });
  return { record, publicToken: link.publicToken, mock: port.mock };
}

async function orgName(orgId: string): Promise<string> {
  return inOrg(orgId, async (tx) => {
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new AppError("NOT_FOUND", "Organization not found");
    return org.name;
  });
}

/**
 * Must run after every successful front-desk link rotate, or the managed number's webhooks
 * keep pointing at the dead token and calls/texts silently stop reaching the workspace.
 * No-op when the workspace has no active number. Failures are logged and reported, not
 * thrown: the rotation itself already succeeded and must not be rolled back.
 */
export async function repointManagedNumberAfterRotate(input: { orgId: string; publicToken: string }): Promise<{ repointed: boolean; warning?: string }> {
  const port = provisioner();
  if (!port) return { repointed: false };
  const store = dbManagedNumberStore();
  try {
    const rec = await store.get(input.orgId);
    if (!rec || rec.status !== "active") return { repointed: false };
    await repointManagedNumber({ port, store, tenantId: input.orgId, publicBase: publicBaseFromEnv(), publicToken: input.publicToken });
    logger.info({ tenantId: input.orgId }, "managed number re-pointed after link rotate");
    return { repointed: true };
  } catch (err) {
    const warning = "The booking link changed, but the phone number could not be re-pointed. Calls and texts may not arrive until you open Front desk settings and retry.";
    logger.error({ tenantId: input.orgId, err }, "managed number re-point failed after rotate");
    return { repointed: false, warning };
  }
}

/** Releases the number back to Twilio. Irreversible; Tier 3 owner approval; audited. */
export async function releaseManagedNumberForOrg(input: { actorUserId: string; orgId: string }): Promise<ManagedNumberRecord> {
  const port = provisionerOrThrow();
  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, ["owner"], "speed.managed_number.release"));
  const record = await releaseManagedNumber({ port, store: dbManagedNumberStore(), tenantId: input.orgId, approval: { approvedBy: input.actorUserId, tier: 3 } });
  await inOrg(input.orgId, async (tx) => {
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "speed.managed_number.release",
      target: `phone:***${record.phone.slice(-4)}`,
      tier: 3,
      outcome: "success",
      metadata: { mock: record.mock },
    });
  });
  return record;
}

/** The owner records the A2P carrier-registration outcome (registration itself happens in Twilio's process). */
export async function recordManagedNumberA2p(input: { actorUserId: string; orgId: string; status: A2pStatus }): Promise<ManagedNumberRecord> {
  await inOrg(input.orgId, (tx) => requireRole(tx, input.orgId, input.actorUserId, ["owner"], "speed.managed_number.a2p"));
  const record = await recordA2pStatus(dbManagedNumberStore(), input.orgId, input.status);
  await inOrg(input.orgId, async (tx) => {
    await recordAudit(tx, {
      tenantId: input.orgId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "speed.managed_number.a2p",
      target: `phone:***${record.phone.slice(-4)}`,
      tier: 1,
      outcome: "success",
      metadata: { a2p: input.status },
    });
  });
  return record;
}
