import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { connectGoogleMailbox, stopBoss } from "@wos/core";
import { createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

const as = (userId: string | null) => createCaller(makeContext(userId));
const NIL = "00000000-0000-4000-8000-000000000000";
let orgA: string;

beforeEach(async () => {
  await resetDb();
  for (const u of ["alice", "mike", "bob"]) await seedUser(u, `${u}@example.test`);
  orgA = (await as("alice").org.create({ name: "A" })).orgId;
  await as("bob").org.create({ name: "B" });
  await as("alice").org.invite({ orgId: orgA, email: "mike@example.test", role: "member" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("inbox endpoints", () => {
  it("reject unauthenticated callers", async () => {
    const anon = as(null);
    for (const c of [
      () => anon.inbox.mailboxes({ orgId: orgA }),
      () => anon.inbox.setMode({ orgId: orgA, identityId: NIL, mode: "send_with_approval" }),
      () => anon.inbox.sync({ orgId: orgA }),
      () => anon.inbox.list({ orgId: orgA }),
      () => anon.inbox.get({ orgId: orgA, conversationId: NIL }),
      () => anon.inbox.triage({ orgId: orgA, conversationId: NIL }),
      () => anon.inbox.requestSend({ orgId: orgA, conversationId: NIL }),
    ]) {
      await expect(c()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("hide org A's mailbox and conversations from org B", async () => {
    await connectGoogleMailbox({ actorUserId: "alice", orgId: orgA, address: "a@acme.test", tokens: { refresh_token: "r" }, scopes: [] });
    for (const c of [
      () => as("bob").inbox.mailboxes({ orgId: orgA }),
      () => as("bob").inbox.list({ orgId: orgA }),
      () => as("bob").inbox.sync({ orgId: orgA }),
      () => as("bob").inbox.get({ orgId: orgA, conversationId: NIL }),
    ]) {
      await expect(c()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("only the owner can switch a mailbox to sending", async () => {
    await connectGoogleMailbox({ actorUserId: "alice", orgId: orgA, address: "a@acme.test", tokens: { refresh_token: "r" }, scopes: [] });
    const [box] = await as("mike").inbox.mailboxes({ orgId: orgA });
    expect(box).toMatchObject({ address: "a@acme.test", mode: "draft_only" });
    expect(Object.keys(box!)).not.toContain("secretCiphertext");
    await expect(as("mike").inbox.setMode({ orgId: orgA, identityId: box!.id, mode: "send_with_approval" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("alice").inbox.setMode({ orgId: orgA, identityId: box!.id, mode: "send_with_approval" })).resolves.toEqual({ mode: "send_with_approval" });
  });
});
