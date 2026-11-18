import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, contacts, conversations, crmRecords, invoices, memoryRecords, messages, withTenant } from "@wos/db";
import {
  addContactNote,
  contact360,
  createDeal,
  createOrg,
  inviteMember,
  listContactsEnriched,
  scoreContact,
  stopBoss,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const OWNER = "c3-owner";
const MEMBER = "c3-member";
const VIEWER = "c3-viewer";
const OUTSIDER = "c3-outsider";

let orgId: string;
let contactId: string;

beforeEach(async () => {
  await resetDb();
  for (const u of [OWNER, MEMBER, VIEWER, OUTSIDER]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: OWNER, name: "360 Co" })).orgId;
  await inviteMember({ actorUserId: OWNER, orgId, email: `${MEMBER}@example.test`, role: "member" });
  await inviteMember({ actorUserId: OWNER, orgId, email: `${VIEWER}@example.test`, role: "viewer" });
  contactId = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(contacts)
      .values({ tenantId: orgId, name: "Ada", email: "ada@acme.com", phone: "+1 555 0100", company: "Acme", source: "inbox" })
      .returning({ id: contacts.id });
    return row!.id;
  });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("lead scoring", () => {
  it("is deterministic and explains every point", () => {
    const hot = scoreContact(
      { email: "ada@acme.com", phone: "+1 555 0100", company: "Acme", source: "inbox" },
      { hasOpenDeal: true, lastActivityAt: new Date().toISOString(), inboundMessageCount: 3 },
      new Date("2026-11-18T12:00:00Z"),
    );
    expect(hot.grade).toBe("hot");
    expect(hot.score).toBe(100); // 110 raw, clamped
    expect(hot.reasons).toHaveLength(8);
    expect(hot.reasons.map((r) => r.id)).toEqual(["company", "phone", "business_email", "has_email", "inbound", "engaged", "open_deal", "recent"]);

    const cold = scoreContact(
      { email: "bob@gmail.com", phone: null, company: null, source: "manual" },
      { hasOpenDeal: false, lastActivityAt: null, inboundMessageCount: 0 },
      new Date("2026-11-18T12:00:00Z"),
    );
    expect(cold.grade).toBe("cold");
    expect(cold.score).toBe(5);
    expect(cold.reasons.map((r) => r.id)).toEqual(["has_email"]);
  });
});

describe("contact notes", () => {
  it("lets staff add append-only notes and keeps everyone else out", async () => {
    const { noteId } = await addContactNote({ actorUserId: MEMBER, orgId, contactId, body: "Called, wants a quote Friday" });
    expect(noteId).toBeTruthy();

    const view = await contact360({ actorUserId: VIEWER, orgId, contactId });
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]!.body).toBe("Called, wants a quote Friday");
    expect(view.notes[0]!.authorName).toBe(MEMBER); // seedUser names users by id

    await expect(addContactNote({ actorUserId: VIEWER, orgId, contactId, body: "no" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addContactNote({ actorUserId: OUTSIDER, orgId, contactId, body: "no" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addContactNote({ actorUserId: MEMBER, orgId, contactId, body: "   " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(contact360({ actorUserId: OUTSIDER, orgId, contactId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("contact 360", () => {
  it("assembles deals, synced rows, invoices, emails, and jobs into one timeline", async () => {
    const { dealId } = await createDeal({ actorUserId: OWNER, orgId, contactId, name: "Roof job", amountCents: 750_000 });

    await withTenant(orgId, async (tx) => {
      await tx.insert(crmRecords).values({
        tenantId: orgId,
        contactId,
        provider: "fake",
        kind: "deal",
        externalId: "ext-1",
        name: "Old synced deal",
        stage: "closedwon",
        amountCents: 100_000,
      });
      await tx.insert(invoices).values({
        tenantId: orgId,
        provider: "fake",
        externalId: "inv-1",
        number: "INV-001",
        customerEmail: "ADA@acme.com", // matched case-insensitively
        status: "open",
        amountDueCents: 42_000,
      });
      const [conv] = await tx
        .insert(conversations)
        .values({ tenantId: orgId, subject: "Roof question", externalThreadId: "t-1" })
        .returning({ id: conversations.id });
      await tx.insert(messages).values({
        tenantId: orgId,
        conversationId: conv!.id,
        direction: "inbound",
        sender: "ada@acme.com",
        recipients: ["owner@360co.test"],
        subject: "Roof question",
        body: "How much for a tear-off?",
        externalId: "m-1",
        sentAt: new Date(),
      });
      await tx.insert(messages).values({
        tenantId: orgId,
        conversationId: conv!.id,
        direction: "inbound",
        sender: "ada@acme.com",
        recipients: ["owner@360co.test"],
        subject: "Roof question",
        body: "Also, gutters?",
        externalId: "m-2",
        sentAt: new Date(),
      });
      // A job for the same customer email (interim job store).
      const now = new Date().toISOString();
      await tx.insert(memoryRecords).values({
        tenantId: orgId,
        layer: "org",
        scopeRef: "job:job-360",
        content: JSON.stringify({
          v: 1,
          id: "job-360",
          tenantId: orgId,
          packId: "moving",
          customerName: "Ada",
          customerEmail: "ada@acme.com",
          customerPhone: null,
          answers: {},
          jurisdiction: "intrastate",
          status: "inquiry",
          crew: [],
          scheduledFor: null,
          createdBy: OWNER,
          createdAt: now,
          updatedAt: now,
          sentAt: null,
        }),
        trust: "verified",
        createdByUser: OWNER,
      });
    });

    const view = await contact360({ actorUserId: MEMBER, orgId, contactId });
    const kinds = new Set(view.timeline.map((t) => t.kind));
    expect(kinds).toContain("deal");
    expect(kinds).toContain("external_deal");
    expect(kinds).toContain("invoice");
    expect(kinds).toContain("message");
    expect(kinds).toContain("job");

    const dealEntry = view.timeline.find((t) => t.kind === "deal")!;
    expect(dealEntry.href).toBe(`/orgs/${orgId}/sales/deals/${dealId}`);
    const msgEntry = view.timeline.find((t) => t.kind === "message")!;
    expect(msgEntry.href).toContain(`/orgs/${orgId}/inbox/`);
    const jobEntry = view.timeline.find((t) => t.kind === "job")!;
    expect(jobEntry.href).toBe(`/orgs/${orgId}/jobs/job-360`);

    expect(view.openDeals).toHaveLength(1);
    expect(view.score.reasons.map((r) => r.id)).toContain("engaged"); // 2 inbound messages
    expect(view.score.reasons.map((r) => r.id)).toContain("open_deal");
  });

  it("enriches the contact list with open-deal counts and scores", async () => {
    await createDeal({ actorUserId: OWNER, orgId, contactId, name: "Roof job", amountCents: 100_000 });
    const list = await listContactsEnriched({ actorUserId: MEMBER, orgId });
    const row = list.find((c) => c.id === contactId)!;
    expect(row.openDealCount).toBe(1);
    expect(row.score.grade).toBe("hot");
    expect(row.score.reasons.map((r) => r.id)).toContain("open_deal");

    await expect(listContactsEnriched({ actorUserId: OUTSIDER, orgId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
