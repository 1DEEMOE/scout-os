import { beforeEach, describe, expect, it } from "vitest";
import {
  configureEngine,
  createOrg,
  createTask,
  exportClaimPacket,
  MockModelProvider,
  ModelRouter,
  ToolRegistry,
  uploadJobPhoto,
  verifyJobPhotoChain,
} from "../src/index";
import { MockLedger, mockTools } from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let jobId: string;

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  configureEngine({
    router: new ModelRouter([new MockModelProvider(() => ({ toolCalls: [] }))], "mock"),
    tools: new ToolRegistry().register(...mockTools(new MockLedger())),
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Photo Co" })).orgId;
  jobId = (await createTask({ actorUserId: "owner", orgId, intent: "Inspect roof", title: "Roof job" })).taskId;
});

describe("tamper-proof job photos", () => {
  it("chains hashes, flags reuploads, and exports a claim packet", async () => {
    const a = await uploadJobPhoto({
      actorUserId: "owner",
      orgId,
      jobId,
      filename: "before.jpg",
      contentType: "image/jpeg",
      bytes: Buffer.from("photo-a-bytes"),
      captureAt: new Date("2026-11-01T12:00:00Z"),
      gpsLat: 30.27,
      gpsLng: -97.74,
    });
    expect(a.chainIndex).toBe(0);
    expect(a.integrityStatus).toBe("ok");
    expect(a.sha256).toHaveLength(64);

    const b = await uploadJobPhoto({
      actorUserId: "owner",
      orgId,
      jobId,
      filename: "after.jpg",
      contentType: "image/jpeg",
      bytes: Buffer.from("photo-b-bytes"),
      captureAt: new Date("2026-11-01T13:00:00Z"),
    });
    expect(b.chainIndex).toBe(1);

    const edited = await uploadJobPhoto({
      actorUserId: "owner",
      orgId,
      jobId,
      filename: "after.jpg",
      contentType: "image/jpeg",
      bytes: Buffer.from("photo-b-bytes-EDITED"),
      captureAt: new Date("2026-11-01T13:05:00Z"),
    });
    expect(edited.integrityStatus).toBe("edited");

    const re = await uploadJobPhoto({
      actorUserId: "owner",
      orgId,
      jobId,
      filename: "before.jpg",
      contentType: "image/jpeg",
      bytes: Buffer.from("photo-a-bytes"),
      captureAt: new Date("2026-11-01T14:00:00Z"),
    });
    expect(re.integrityStatus).toBe("reuploaded");
    expect(re.photoId).toBe(a.photoId);

    const verify = await verifyJobPhotoChain({ actorUserId: "owner", orgId, jobId });
    expect(verify.chainIntact).toBe(true);
    expect(verify.flagged.some((f) => f.status === "edited")).toBe(true);

    const packet = await exportClaimPacket({ actorUserId: "owner", orgId, jobId });
    expect(packet.html).toContain("Claim packet");
    expect(packet.html).toContain(a.sha256);
    expect(packet.html).toContain("width=device-width");
    expect(packet.html).toContain("table-layout:fixed");
    expect(packet.html).toContain("overflow-wrap:anywhere");
    expect(packet.filename).toMatch(/claim-packet-/);
  });
});
