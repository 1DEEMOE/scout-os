import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

// Endpoint-level authorization and tenant isolation for every M1 procedure.

const as = (userId: string | null) => createCaller(makeContext(userId));

beforeEach(async () => {
  await resetDb();
  await seedUser("alice", "alice@example.test", "Alice");
  await seedUser("bob", "bob@example.test", "Bob");
  await seedUser("carol", "carol@example.test", "Carol");
});

afterAll(async () => {
  await closePool();
});

describe("unauthenticated callers", () => {
  it("are rejected by every procedure", async () => {
    const anon = as(null);
    const calls = [
      () => anon.org.create({ name: "X" }),
      () => anon.org.invite({ orgId: "00000000-0000-4000-8000-000000000000", email: "a@b.co", role: "member" }),
      () => anon.org.listMembers({ orgId: "00000000-0000-4000-8000-000000000000" }),
      () => anon.org.listMine(),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("org endpoints", () => {
  it("create, invite and list work for the owner", async () => {
    const { orgId } = await as("alice").org.create({ name: "Alice Tax" });
    await as("alice").org.invite({ orgId, email: "bob@example.test", role: "member" });
    const members = await as("alice").org.listMembers({ orgId });
    expect(members.map((m) => m.email)).toEqual(["alice@example.test", "bob@example.test"]);
    expect(await as("bob").org.listMine()).toEqual([{ orgId, name: "Alice Tax", role: "member" }]);
  });

  it("map service errors to the right codes with safe messages", async () => {
    const { orgId } = await as("alice").org.create({ name: "Alice Tax" });
    await as("alice").org.invite({ orgId, email: "bob@example.test", role: "member" });
    await expect(as("alice").org.create({ name: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as("bob").org.invite({ orgId, email: "carol@example.test", role: "member" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You don't have permission to do that",
    });
    await expect(as("alice").org.invite({ orgId, email: "bob@example.test", role: "member" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("isolate tenants: another org's id is NOT_FOUND for list and invite", async () => {
    const { orgId: aliceOrg } = await as("alice").org.create({ name: "Alice Tax" });
    const { orgId: carolOrg } = await as("carol").org.create({ name: "Carol Books" });
    await expect(as("alice").org.listMembers({ orgId: carolOrg })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("alice").org.invite({ orgId: carolOrg, email: "bob@example.test", role: "admin" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await as("alice").org.listMine()).map((o) => o.orgId)).toEqual([aliceOrg]);
    expect((await as("carol").org.listMembers({ orgId: carolOrg })).map((m) => m.userId)).toEqual(["carol"]);
  });

  it("treat malformed org ids as NOT_FOUND, not a server error", async () => {
    await expect(as("alice").org.listMembers({ orgId: "'; DROP TABLE users; --" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
