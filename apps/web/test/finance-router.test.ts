import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { stopBoss } from "@wos/core";
import { createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

const as = (userId: string | null) => createCaller(makeContext(userId));
let orgA: string;

beforeEach(async () => {
  await resetDb();
  for (const u of ["alice", "adam", "bob"]) await seedUser(u, `${u}@example.test`);
  orgA = (await as("alice").org.create({ name: "A" })).orgId;
  await as("bob").org.create({ name: "B" });
  await as("alice").org.invite({ orgId: orgA, email: "adam@example.test", role: "admin" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("finance endpoints", () => {
  it("reject unauthenticated callers", async () => {
    const anon = as(null);
    for (const c of [
      () => anon.finance.connectStripe({ orgId: orgA, secretKey: "sk_test_x1" }),
      () => anon.finance.sync({ orgId: orgA }),
      () => anon.finance.invoices({ orgId: orgA }),
      () => anon.finance.overdue({ orgId: orgA }),
      () => anon.finance.chaseOverdue({ orgId: orgA }),
    ]) {
      await expect(c()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("enforce owner-only Stripe connection and tenant isolation", async () => {
    await expect(as("adam").finance.connectStripe({ orgId: orgA, secretKey: "sk_test_x1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("alice").finance.connectStripe({ orgId: orgA, secretKey: "sk_test_x1" })).resolves.toMatchObject({ live: false });
    for (const c of [() => as("bob").finance.invoices({ orgId: orgA }), () => as("bob").finance.overdue({ orgId: orgA }), () => as("bob").finance.chaseOverdue({ orgId: orgA }), () => as("bob").finance.sync({ orgId: orgA })]) {
      await expect(c()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
