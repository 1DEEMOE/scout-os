import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  addJobNote,
  configureEngine,
  createOrg,
  createTask,
  exportClaimPacket,
  exportClaimPacketPdf,
  inviteMember,
  MockLedger,
  MockModelProvider,
  mockTools,
  ModelRouter,
  packetFingerprint,
  sha256Buffer,
  ToolRegistry,
  uploadJobPhoto,
  verifyJobPhotoChain,
} from "../src/index";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let jobId: string;
const STORAGE = process.env.WOS_JOB_PHOTO_DIR || path.join(process.cwd(), ".job-photos");
// A real 1x1 PNG, so the PDF embeds an actual image.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test", "Olivia Owner");
  await seedUser("viewer", "viewer@example.test");
  await seedUser("outsider", "outsider@example.test");
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({ toolCalls: [] }))], "mock"), tools: new ToolRegistry().register(...mockTools(new MockLedger())) });
  orgId = (await createOrg({ actorUserId: "owner", name: "Peachtree Roofing" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "viewer@example.test", role: "viewer" });
  await createOrg({ actorUserId: "outsider", name: "Elsewhere" });
  jobId = (await createTask({ actorUserId: "owner", orgId, intent: "Insurance claim: 12 Magnolia Way", title: "Claim 12 Magnolia Way" })).taskId;
});

describe("tamper-resistant claim packet", () => {
  it("chains notes with photos: hashed, timestamped, attributed, in order", async () => {
    const p1 = await uploadJobPhoto({ actorUserId: "owner", orgId, jobId, filename: "north-slope.png", contentType: "image/png", bytes: PNG, captureAt: new Date("2026-11-04T15:00:00Z"), gpsLat: 33.749, gpsLng: -84.388 });
    const n1 = await addJobNote({ actorUserId: "owner", orgId, jobId, text: "Hail bruising on the north slope, 8 hits per test square.", observedAt: new Date("2026-11-04T15:05:00Z") });
    expect(n1.chainIndex).toBe(1);
    expect(n1.sha256).toBe(sha256Buffer(Buffer.from("Hail bruising on the north slope, 8 hits per test square.", "utf8")));
    const v = await verifyJobPhotoChain({ actorUserId: "owner", orgId, jobId });
    expect(v.chainIntact).toBe(true);
    expect(v.photos.map((x) => [x.chainIndex, x.kind])).toEqual([[0, "photo"], [1, "note"]]);
    expect(v.photos[1]!.prevSha256).toBe(p1.sha256);
    const audit = await adminQuery<{ action: string; actor_id: string }>("SELECT action, actor_id FROM audit_events WHERE tenant_id = $1 AND action IN ('job_photo.upload','job_note.add')", [orgId]);
    expect(audit).toHaveLength(2);
    expect(audit).toEqual(expect.arrayContaining([{ action: "job_photo.upload", actor_id: "owner" }, { action: "job_note.add", actor_id: "owner" }]));
  });

  it("exports a real PDF with every hash and a reproducible fingerprint; the HTML has the notes too", async () => {
    await uploadJobPhoto({ actorUserId: "owner", orgId, jobId, filename: "a.png", contentType: "image/png", bytes: PNG, captureAt: new Date("2026-11-04T15:00:00Z") });
    await addJobNote({ actorUserId: "owner", orgId, jobId, text: "Gutters dented on the east side — see photo #0." });
    const out = await exportClaimPacketPdf({ actorUserId: "viewer", orgId, jobId }); // read-only roles can export
    expect(Buffer.from(out.pdf.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(out.pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toMatch(/Claim packet/);
    expect(out.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Same packet → same fingerprint; the fingerprint is over the item list only.
    const again = await exportClaimPacketPdf({ actorUserId: "owner", orgId, jobId });
    expect(again.fingerprint).toBe(out.fingerprint);
    expect(packetFingerprint(jobId, [])).not.toBe(out.fingerprint);
    const { html } = await exportClaimPacket({ actorUserId: "owner", orgId, jobId });
    expect(html).toContain("Gutters dented on the east side");
    // A new item changes the fingerprint.
    await addJobNote({ actorUserId: "owner", orgId, jobId, text: "Homeowner present during inspection." });
    expect((await exportClaimPacketPdf({ actorUserId: "owner", orgId, jobId })).fingerprint).not.toBe(out.fingerprint);
  });

  it("an edited note on disk is caught", async () => {
    await addJobNote({ actorUserId: "owner", orgId, jobId, text: "Original observation." });
    const [row] = await adminQuery<{ storage_ref: string }>("SELECT storage_ref FROM job_photos WHERE job_id = $1", [jobId]);
    const file = path.join(STORAGE, row!.storage_ref);
    expect(await readFile(file, "utf8")).toBe("Original observation.");
    await writeFile(file, "Changed after the fact.");
    const v = await verifyJobPhotoChain({ actorUserId: "owner", orgId, jobId });
    expect(v.chainIntact).toBe(false);
    expect(v.photos[0]!.bytesMatch).toBe(false);
  });

  it("validates notes and keeps other orgs and viewers out of writing", async () => {
    await expect(addJobNote({ actorUserId: "owner", orgId, jobId, text: " " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addJobNote({ actorUserId: "viewer", orgId, jobId, text: "Not allowed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addJobNote({ actorUserId: "outsider", orgId, jobId, text: "Not allowed" })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    await expect(exportClaimPacketPdf({ actorUserId: "outsider", orgId, jobId })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });
});
