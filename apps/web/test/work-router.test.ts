import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { stopBoss } from "@wos/core";
import { createCaller } from "../src/server/root";
import { makeContext } from "../src/server/trpc";
import { resetDb, seedUser } from "../../../packages/db/test/helpers";

// Authorization and tenant isolation for every Milestone 2 procedure.

const as = (userId: string | null) => createCaller(makeContext(userId));
const NIL = "00000000-0000-4000-8000-000000000000";
let orgA: string;
let orgB: string;

const inboxSpec = {
  kind: "inbox" as const,
  displayName: "Inbox",
  instructions: "Handle mail",
  tools: [{ name: "mock.note", maxTier: 1 }],
};

beforeEach(async () => {
  await resetDb();
  for (const u of ["alice", "mike", "vera", "bob"]) await seedUser(u, `${u}@example.test`);
  orgA = (await as("alice").org.create({ name: "A" })).orgId;
  orgB = (await as("bob").org.create({ name: "B" })).orgId;
  await as("alice").org.invite({ orgId: orgA, email: "mike@example.test", role: "member" });
  await as("alice").org.invite({ orgId: orgA, email: "vera@example.test", role: "viewer" });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("unauthenticated callers", () => {
  it("are rejected by every M2 procedure", async () => {
    const anon = as(null);
    const calls = [
      () => anon.agent.list({ orgId: orgA }),
      () => anon.agent.create({ orgId: orgA, spec: inboxSpec }),
      () => anon.task.create({ orgId: orgA, intent: "x" }),
      () => anon.task.list({ orgId: orgA }),
      () => anon.task.get({ orgId: orgA, taskId: NIL }),
      () => anon.approval.list({ orgId: orgA }),
      () => anon.approval.decide({ orgId: orgA, approvalId: NIL, decision: "approve" }),
      () => anon.approval.confirm({ orgId: orgA, approvalId: NIL }),
      () => anon.agent.provisionRecommended({ orgId: orgA }),
      () => anon.audit.list({ orgId: orgA }),
    ];
    for (const c of calls) await expect(c()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("roles", () => {
  it("only owners and admins create agents; viewers can't create tasks; members can't decide approvals", async () => {
    await expect(as("mike").agent.create({ orgId: orgA, spec: inboxSpec })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as("alice").agent.create({ orgId: orgA, spec: inboxSpec });
    await expect(as("vera").task.create({ orgId: orgA, intent: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { taskId } = await as("mike").task.create({ orgId: orgA, intent: "note it" });
    expect((await as("vera").task.get({ orgId: orgA, taskId })).task.intent).toBe("note it");
    await expect(as("mike").approval.decide({ orgId: orgA, approvalId: NIL, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects agents with unknown tools", async () => {
    await expect(
      as("alice").agent.create({ orgId: orgA, spec: { ...inboxSpec, tools: [{ name: "shell.exec", maxTier: 4 }] } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("tenant isolation", () => {
  it("org B's owner sees nothing of org A", async () => {
    await as("alice").agent.create({ orgId: orgA, spec: inboxSpec });
    const { taskId } = await as("alice").task.create({ orgId: orgA, intent: "secret plan" });
    for (const c of [
      () => as("bob").agent.list({ orgId: orgA }),
      () => as("bob").task.list({ orgId: orgA }),
      () => as("bob").task.get({ orgId: orgA, taskId }),
      () => as("bob").approval.list({ orgId: orgA }),
      () => as("bob").task.create({ orgId: orgA, intent: "x" }),
    ]) {
      await expect(c()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // Asking for A's task under B's org id finds nothing either.
    await expect(as("bob").task.get({ orgId: orgB, taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await as("bob").task.list({ orgId: orgB })).toEqual([]);
  });
});

describe("recommended agents and audit", () => {
  it("only managers provision agents; it's idempotent; members can't read the audit log; other orgs can't either", async () => {
    await expect(as("mike").agent.provisionRecommended({ orgId: orgA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as("alice").agent.provisionRecommended({ orgId: orgA })).toEqual({ created: ["inbox", "sales", "finance"] });
    expect(await as("alice").agent.provisionRecommended({ orgId: orgA })).toEqual({ created: [] });
    expect((await as("vera").agent.list({ orgId: orgA })).map((a) => a.kind).sort()).toEqual(["finance", "inbox", "sales"]);
    await expect(as("mike").audit.list({ orgId: orgA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("bob").audit.list({ orgId: orgA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const events = await as("alice").audit.list({ orgId: orgA, actionPrefix: "agent." });
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ["agent.create", "success"],
      ["agent.create", "success"],
      ["agent.create", "success"],
      ["agent.provision", "denied"], // the member's refused attempt is on record too
    ]);
  });
});

describe("memory endpoints", () => {
  it("enforce authentication, roles and tenant isolation", async () => {
    for (const c of [() => as(null).memory.list({ orgId: orgA }), () => as(null).memory.add({ orgId: orgA, content: "x" }), () => as(null).memory.forget({ orgId: orgA, memoryId: NIL })]) {
      await expect(c()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    await expect(as("vera").memory.add({ orgId: orgA, content: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const fact = await as("mike").memory.add({ orgId: orgA, content: "We close at 5pm" });
    await expect(as("mike").memory.forget({ orgId: orgA, memoryId: fact.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("bob").memory.list({ orgId: orgA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("alice").memory.forget({ orgId: orgA, memoryId: fact.id })).resolves.toEqual({ deleted: fact.id });
  });
});

describe("agent switch and retry endpoints", () => {
  it("only owners pause; members can read the state; other orgs can't touch it", async () => {
    await expect(as("mike").agent.setPaused({ orgId: orgA, paused: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("bob").agent.setPaused({ orgId: orgA, paused: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("alice").agent.setPaused({ orgId: orgA, paused: true })).resolves.toMatchObject({ paused: true });
    expect(await as("vera").agent.pauseState({ orgId: orgA })).toMatchObject({ paused: true, pausedByName: "alice" });
    await expect(as("bob").agent.pauseState({ orgId: orgA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("alice").agent.setPaused({ orgId: orgA, paused: false })).resolves.toMatchObject({ paused: false });
  });

  it("retry needs a manager and an escalated task", async () => {
    await as("alice").agent.create({ orgId: orgA, spec: inboxSpec });
    const { taskId } = await as("mike").task.create({ orgId: orgA, intent: "note it" });
    await expect(as("mike").task.retry({ orgId: orgA, taskId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("alice").task.retry({ orgId: orgA, taskId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(as("bob").task.retry({ orgId: orgA, taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
