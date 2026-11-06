import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, memoryRecords, withTenant } from "@wos/db";
import { configureEngine, createOrg, MockModelProvider, ModelRouter, stopBoss, ToolRegistry } from "../src/index";
import { workspaceSnapshot } from "../src/chat/read";
import { resetDb, seedUser } from "../../db/test/helpers";

beforeEach(async () => {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  configureEngine({ router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"), tools: new ToolRegistry() });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("cross-tenant context", () => {
  it("a snapshot for tenant B does not count tenant A's leads", async () => {
    const a = (await createOrg({ actorUserId: "owner", name: "A" })).orgId;
    const b = (await createOrg({ actorUserId: "owner", name: "B" })).orgId;
    await withTenant(a, (tx) =>
      tx.insert(memoryRecords).values({ tenantId: a, layer: "working", scopeRef: "speed:lead:1", content: "lead", trust: "agent", createdByUser: "owner" }),
    );
    const seen = await withTenant(b, (tx) => workspaceSnapshot(tx, b));
    expect(seen).toMatch(/0 timed leads/);
    const own = await withTenant(a, (tx) => workspaceSnapshot(tx, a));
    expect(own).toMatch(/1 timed lead/);
  });
});
