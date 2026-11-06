import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, conversations, emailIdentities, messages, withTenant } from "@wos/db";
import {
  configureEngine,
  connectGoogleMailbox,
  createOrg,
  disconnectIntegration,
  FakeMailProvider,
  handleInboxSyncJob,
  listIntegrations,
  MockModelProvider,
  ModelRouter,
  stopBoss,
  ToolRegistry,
  type MailboxResolver,
} from "../src/index";
import { ownerQuery, resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;
let mail: FakeMailProvider;

const resolver: MailboxResolver = async (tenantId) => {
  const [identity] = await withTenant(tenantId, (tx) => tx.select().from(emailIdentities));
  return identity ? { provider: mail, identity } : null;
};

function fakeMessage(id: string) {
  return {
    externalId: id,
    rfc822MessageId: `<${id}@mail.test>`,
    threadId: `thr-${id}`,
    direction: "inbound" as const,
    from: "customer@example.test",
    to: ["us@example.test"],
    subject: `Question ${id}`,
    body: "How much is the plan?",
    sentAt: new Date("2026-11-01T10:00:00Z"),
  };
}

async function syncJobs() {
  return ownerQuery<{ state: string; start_after: Date; data: { identityId: string }; singleton_key: string }>(
    "SELECT state, start_after, data, singleton_key FROM pgboss.job WHERE name = 'inbox.sync' AND state = 'created'",
  );
}

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  mail = new FakeMailProvider();
  configureEngine({
    router: new ModelRouter([new MockModelProvider(() => ({ toolCalls: [] }))], "mock"),
    tools: new ToolRegistry(),
    mailbox: resolver,
    retryBaseSeconds: 1,
  });
  orgId = (await createOrg({ actorUserId: "owner", name: "Inbox Co" })).orgId;
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("background inbox sync", () => {
  it("connecting a mailbox enqueues the first sync job; reconnecting does not duplicate it", async () => {
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "us@example.test", tokens: { refresh_token: "r", access_token: "a" }, scopes: ["gmail.readonly"] });
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "us@example.test", tokens: { refresh_token: "r2", access_token: "a2" }, scopes: ["gmail.readonly"] });
    const jobs = await syncJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.singleton_key).toMatch(/^inbox-sync:/);
  });

  it("the handler pulls new mail and schedules the next beat", async () => {
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "us@example.test", tokens: { refresh_token: "r", access_token: "a" }, scopes: ["gmail.readonly"] });
    const identityId = (await syncJobs())[0]!.data.identityId;
    mail.inbox.push(fakeMessage("m1"), fakeMessage("m2"));

    // Simulate the worker claiming the job whose run we invoke directly.
    await ownerQuery("DELETE FROM pgboss.job WHERE name = 'inbox.sync'");
    await handleInboxSyncJob({ tenantId: orgId, identityId });

    const convs = await withTenant(orgId, (tx) => tx.select().from(conversations));
    expect(convs).toHaveLength(2);
    const msgs = await withTenant(orgId, (tx) => tx.select().from(messages));
    expect(msgs).toHaveLength(2);

    // The chain continues: exactly one delayed job waiting.
    const jobs = await syncJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.start_after.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // A second beat with no new mail adds nothing (idempotent).
    await ownerQuery("DELETE FROM pgboss.job WHERE name = 'inbox.sync'");
    await handleInboxSyncJob({ tenantId: orgId, identityId });
    expect(await withTenant(orgId, (tx) => tx.select().from(messages))).toHaveLength(2);
    expect(await syncJobs()).toHaveLength(1);
  });

  it("the chain stops after the integration is disconnected", async () => {
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "us@example.test", tokens: { refresh_token: "r", access_token: "a" }, scopes: ["gmail.readonly"] });
    const identityId = (await syncJobs())[0]!.data.identityId;
    const connId = (await listIntegrations({ actorUserId: "owner", orgId }))[0]!.id;

    await disconnectIntegration({ actorUserId: "owner", orgId, connectionId: connId });
    expect(await listIntegrations({ actorUserId: "owner", orgId })).toEqual([]);
    expect(await withTenant(orgId, (tx) => tx.select().from(emailIdentities))).toHaveLength(0);

    await ownerQuery("DELETE FROM pgboss.job WHERE name = 'inbox.sync'");
    await handleInboxSyncJob({ tenantId: orgId, identityId });
    expect(await syncJobs()).toHaveLength(0); // no re-enqueue: the chain is dead
  });

  it("a failed pull keeps the chain alive for the next beat", async () => {
    await connectGoogleMailbox({ actorUserId: "owner", orgId, address: "us@example.test", tokens: { refresh_token: "r", access_token: "a" }, scopes: ["gmail.readonly"] });
    const identityId = (await syncJobs())[0]!.data.identityId;
    mail.listRecent = () => Promise.reject(new Error("MOCK provider outage"));

    await ownerQuery("DELETE FROM pgboss.job WHERE name = 'inbox.sync'");
    await handleInboxSyncJob({ tenantId: orgId, identityId });
    const jobs = await syncJobs();
    expect(jobs).toHaveLength(1); // next beat scheduled despite the failure
  });
});
