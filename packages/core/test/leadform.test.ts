import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closePool, contacts, withTenant } from "@wos/db";
import {
  contact360,
  createOrg,
  enableFrontDesk,
  getLeadFormSettings,
  getPublicLeadForm,
  inviteMember,
  listPipeline,
  saveLeadFormSettings,
  setFrontDeskStatus,
  stopBoss,
  submitLeadForm,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

const OWNER = "lf-owner";
const VIEWER = "lf-viewer";
const OUTSIDER = "lf-outsider";

let orgId: string;
let channelId: string;
let token: string;

beforeEach(async () => {
  await resetDb();
  for (const u of [OWNER, VIEWER, OUTSIDER]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: OWNER, name: "Lead Co" })).orgId;
  await inviteMember({ actorUserId: OWNER, orgId, email: `${VIEWER}@example.test`, role: "viewer" });
  const ch = await enableFrontDesk({ actorUserId: OWNER, orgId, displayName: "Lead Co" });
  channelId = ch.channelId;
  token = ch.publicToken;
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

async function enableForm() {
  await saveLeadFormSettings({ actorUserId: OWNER, orgId, channelId, form: { enabled: true } });
}

async function contactCount(): Promise<number> {
  return withTenant(orgId, async (tx) => (await tx.select({ id: contacts.id }).from(contacts)).length);
}

describe("lead form settings", () => {
  it("defaults to off and is manager-only to change", async () => {
    const settings = await getLeadFormSettings({ actorUserId: VIEWER, orgId });
    expect(settings.channel).toMatchObject({ id: channelId, displayName: "Lead Co" });
    expect(settings.form.enabled).toBe(false);
    // The settings payload never carries the token hash.
    expect(JSON.stringify(settings)).not.toMatch(/[0-9a-f]{64}/);

    await expect(saveLeadFormSettings({ actorUserId: VIEWER, orgId, channelId, form: { enabled: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(saveLeadFormSettings({ actorUserId: OUTSIDER, orgId, channelId, form: { enabled: true } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(saveLeadFormSettings({ actorUserId: OWNER, orgId, channelId: "00000000-0000-4000-8000-000000000000", form: { enabled: true } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await enableForm();
    expect((await getLeadFormSettings({ actorUserId: OWNER, orgId })).form.enabled).toBe(true);
  });
});

describe("public lead form", () => {
  it("answers NOT_FOUND while disabled, for bad tokens, and while the desk is paused", async () => {
    await expect(getPublicLeadForm(token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getPublicLeadForm("not-a-real-token-at-all")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await enableForm();
    const pub = await getPublicLeadForm(token);
    expect(pub.businessName).toBe("Lead Co");
    expect(pub.askMessage).toBe(true);

    await setFrontDeskStatus({ actorUserId: OWNER, orgId, channelId, status: "paused" });
    await expect(getPublicLeadForm(token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      submitLeadForm({ publicToken: token, name: "Maya", email: "maya@hopper.test", sourceIp: "8.8.8.8" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("turns a submission into a contact, a web-form deal, and a timeline entry", async () => {
    await enableForm();
    const result = await submitLeadForm({
      publicToken: token,
      name: "Maya Lead",
      email: "Maya@Hopper.test",
      phone: "+1 314 555 0100",
      company: "Hopper LLC",
      message: "Need a roof before winter",
      sourceIp: "9.9.9.9",
    });
    expect(result).toEqual({ ok: true });

    const [contact] = await withTenant(orgId, (tx) => tx.select().from(contacts).where(sql`lower(${contacts.email}) = 'maya@hopper.test'`));
    expect(contact).toBeDefined();
    expect(contact!.email).toBe("maya@hopper.test"); // lowercased
    expect(contact!.source).toBe("inbox"); // interim until 0027 adds 'web_form'
    expect(contact!.company).toBe("Hopper LLC");

    const board = await listPipeline({ actorUserId: OWNER, orgId });
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ name: "Hopper LLC — web form", stage: "lead", source: "web_form", contactId: contact!.id });

    const view = await contact360({ actorUserId: OWNER, orgId, contactId: contact!.id });
    const formEntry = view.timeline.find((t) => t.kind === "lead_form");
    expect(formEntry).toBeDefined();
    expect(formEntry!.detail).toBe("Need a roof before winter");
  });

  it("dedupes repeat submissions: one contact, one open deal, latest details win", async () => {
    await enableForm();
    for (const phone of ["+1 314 555 0001", "+1 314 555 0002", "+1 314 555 0003"]) {
      await submitLeadForm({ publicToken: token, name: "Repeat Randy", email: "randy@dupes.test", phone, sourceIp: "7.7.7.7" });
    }
    expect(await contactCount()).toBe(1);
    const [contact] = await withTenant(orgId, (tx) => tx.select().from(contacts));
    expect(contact!.phone).toBe("+1 314 555 0003");
    expect(await listPipeline({ actorUserId: OWNER, orgId })).toHaveLength(1);
  });

  it("silently accepts honeypot submissions without storing anything", async () => {
    await enableForm();
    const result = await submitLeadForm({
      publicToken: token,
      name: "Botty McBotface",
      email: "bot@spamfarm.test",
      website: "http://spam.example", // honeypot: humans never fill this
      sourceIp: "6.6.6.6",
    });
    expect(result).toEqual({ ok: true });
    expect(await contactCount()).toBe(0);
    expect(await listPipeline({ actorUserId: OWNER, orgId })).toHaveLength(0);
  });

  it("validates before counting, then rate-limits floods", async () => {
    await enableForm();
    await expect(submitLeadForm({ publicToken: token, name: "", email: "a@b.test", sourceIp: "5.5.5.5" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(submitLeadForm({ publicToken: token, name: "X", email: "not-an-email", sourceIp: "5.5.5.5" })).rejects.toMatchObject({ code: "VALIDATION" });

    // Those two invalid attempts consumed nothing: 10 valid submissions from
    // the same address still pass, and the 11th is limited.
    const ip = "5.5.5.5";
    for (let i = 0; i < 10; i++) {
      await submitLeadForm({ publicToken: token, name: `Human ${i}`, email: `human-${i}@real.test`, sourceIp: ip });
    }
    await expect(submitLeadForm({ publicToken: token, name: "One too many", email: "too-many@real.test", sourceIp: ip })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});
