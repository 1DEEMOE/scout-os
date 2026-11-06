import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { stopBoss } from "@wos/core";
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

describe("crm endpoints", () => {
  it("reject unauthenticated callers", async () => {
    const anon = as(null);
    for (const c of [
      () => anon.crm.connectHubSpot({ orgId: orgA, accessToken: "pat-xxxxxxxxxxxx", label: "p" }),
      () => anon.crm.contacts({ orgId: orgA }),
      () => anon.crm.deals({ orgId: orgA }),
      () => anon.crm.qualifyLead({ orgId: orgA, conversationId: NIL }),
    ]) {
      await expect(c()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("enforce roles and tenant isolation", async () => {
    await expect(as("mike").crm.connectHubSpot({ orgId: orgA, accessToken: "pat-xxxxxxxxxxxx", label: "p" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("alice").crm.connectHubSpot({ orgId: orgA, accessToken: "pat-xxxxxxxxxxxx", label: "p" })).resolves.toHaveProperty("connectionId");
    for (const c of [() => as("bob").crm.contacts({ orgId: orgA }), () => as("bob").crm.deals({ orgId: orgA }), () => as("bob").crm.qualifyLead({ orgId: orgA, conversationId: NIL })]) {
      await expect(c()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await as("mike").crm.deals({ orgId: orgA })).toEqual([]);
  });
});
