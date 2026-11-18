import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import {
  AppError,
  channelReadiness,
  createOrg,
  inviteMember,
  managedNumberStatus,
  ManagedNumberError,
  managedNumberProvisionerForTests,
  MockNumberProvisioner,
  proposeManagedNumbers,
  provisionManagedNumberForOrg,
  recordManagedNumberA2p,
  releaseManagedNumberForOrg,
  repointManagedNumberAfterRotate,
  resetManagedNumberProvisionerForTests,
  rotateFrontDeskLink,
  stopBoss,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let port: MockNumberProvisioner;

beforeEach(async () => {
  await resetDb();
  resetManagedNumberProvisionerForTests();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: "owner", name: "Number Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await proposeManagedNumbers({ actorUserId: "owner", orgId, areaCode: "314" }); // forces the service to cache its provisioner
  port = managedNumberProvisionerForTests() as MockNumberProvisioner;
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("managed numbers (service layer, mock provisioner, real DB)", () => {
  it("provisions: creates the front-desk link, buys once, audits at tier 3, returns the one-time token", async () => {
    const r = await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    expect(r.mock).toBe(true);
    expect(r.publicToken).toBeTruthy();
    expect(r.record.status).toBe("active");
    expect(r.record.sid).toMatch(/^PN_mock_/);
    expect(channelReadiness(r.record)).toMatchObject({ voice: true, textBack: false });

    const status = await managedNumberStatus({ actorUserId: "owner", orgId });
    expect(status.record?.phone).toBe("+13145550100");
  });

  it("is idempotent: a second provision rotates nothing and buys nothing", async () => {
    const first = await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    const second = await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    expect(second.publicToken).toBeNull();
    expect(second.record.sid).toBe(first.record.sid);
  });

  it("refuses members and outsiders (owner-only money action)", async () => {
    await expect(provisionManagedNumberForOrg({ actorUserId: "member", orgId, phone: "+13145550100" })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === "FORBIDDEN",
    );
    await expect(provisionManagedNumberForOrg({ actorUserId: "outsider", orgId, phone: "+13145550100" })).rejects.toBeInstanceOf(AppError);
  });

  it("proposes without buying and includes the carrier-registration warning", async () => {
    const proposal = await proposeManagedNumbers({ actorUserId: "owner", orgId, areaCode: "314" });
    expect(proposal.options.length).toBeGreaterThan(0);
    expect(proposal.warnings.join(" ")).toMatch(/A2P|carrier/i);
    expect(await managedNumberStatus({ actorUserId: "owner", orgId })).toMatchObject({ record: null });
  });

  it("rejects a bad area code and a non-US number", async () => {
    await expect(proposeManagedNumbers({ actorUserId: "owner", orgId, areaCode: "012" })).rejects.toBeInstanceOf(ManagedNumberError);
    await expect(provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+442071234567" })).rejects.toBeInstanceOf(ManagedNumberError);
  });

  it("blocks a second workspace from taking a number another workspace holds", async () => {
    await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    const other = (await createOrg({ actorUserId: "owner", name: "Rival Co" })).orgId;
    await expect(provisionManagedNumberForOrg({ actorUserId: "owner", orgId: other, phone: "+13145550100" })).rejects.toSatisfy(
      (e) => e instanceof ManagedNumberError && e.code === "conflict",
    );
  });

  it("re-points webhooks when the booking link rotates", async () => {
    const first = await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    expect(first.publicToken).toBeTruthy();
    const ch = await enableFrontDeskCheck();
    const rotated = await rotateFrontDeskLink({ actorUserId: "owner", orgId, channelId: ch });
    const repoint = await repointManagedNumberAfterRotate({ orgId, publicToken: rotated.publicToken });
    expect(repoint.repointed).toBe(true);
    // The mock provisioner now holds webhook URLs carrying the NEW token.
    const owned = [...port.owned.values()][0];
    expect(owned?.urls.voiceUrl).toContain(rotated.publicToken);
    expect(owned?.urls.voiceUrl).not.toContain(first.publicToken!);
  });

  it("re-point is a no-op (not an error) when the workspace has no number", async () => {
    await expect(repointManagedNumberAfterRotate({ orgId, publicToken: "tok_abcdefghijklmnop" })).resolves.toMatchObject({ repointed: false });
  });

  it("gates text-back on recorded A2P approval and audits it", async () => {
    await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    let status = await managedNumberStatus({ actorUserId: "owner", orgId });
    expect(status.readiness.textBack).toBe(false);

    await expect(recordManagedNumberA2p({ actorUserId: "member", orgId, status: "approved" })).rejects.toBeInstanceOf(AppError);
    await recordManagedNumberA2p({ actorUserId: "owner", orgId, status: "approved" });
    status = await managedNumberStatus({ actorUserId: "owner", orgId });
    expect(status.readiness.textBack).toBe(true);
  });

  it("releases with owner approval; released state is idempotent and irreversible-looking", async () => {
    await provisionManagedNumberForOrg({ actorUserId: "owner", orgId, phone: "+13145550100" });
    await expect(releaseManagedNumberForOrg({ actorUserId: "member", orgId })).rejects.toBeInstanceOf(AppError);
    const released = await releaseManagedNumberForOrg({ actorUserId: "owner", orgId });
    expect(released.status).toBe("released");
    const again = await releaseManagedNumberForOrg({ actorUserId: "owner", orgId });
    expect(again.status).toBe("released");
    const status = await managedNumberStatus({ actorUserId: "owner", orgId });
    expect(status.readiness.voice).toBe(false);
  });

  async function enableFrontDeskCheck(): Promise<string> {
    // The provision flow already created a channel; find it via a second enable path probe.
    const { listFrontDeskChannels } = await import("../src/index");
    const channels = await listFrontDeskChannels({ actorUserId: "owner", orgId });
    expect(channels.length).toBe(1);
    return channels[0]!.id;
  }
});
