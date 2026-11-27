import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { prune } from "../../../scripts/prune-events.mjs";
import { adminQuery, resetDb } from "./helpers";

const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
let tenant = "";
const ev = (key: string, status: string, days: number) =>
  adminQuery(
    "INSERT INTO integration_events (tenant_id, idempotency_key, type, source, status, created_at, lease_owner, lease_expires_at) VALUES ($1,$2,'t','s',$3, now() - ($4 * interval '1 day'), CASE WHEN $3 = 'in_progress' THEN 'w' END, CASE WHEN $3 = 'in_progress' THEN now() END)",
    [tenant, key, status, days],
  );
const dl = (key: string, replayedDaysAgo: number | null) =>
  adminQuery(
    "INSERT INTO dead_letters (tenant_id, event_key, type, source, error, attempts, replayed_at) VALUES ($1,$2,'t','s','e',1, CASE WHEN $3::int IS NULL THEN NULL ELSE now() - ($3::int * interval '1 day') END)",
    [tenant, key, replayedDaysAgo],
  );
const keys = async (t: string) => (await adminQuery<{ k: string }>(`SELECT ${t === "e" ? "idempotency_key" : "event_key"} AS k FROM ${t === "e" ? "integration_events" : "dead_letters"} ORDER BY 1`)).map((r) => r.k);

describe("prune-events", () => {
  beforeEach(async () => {
    await resetDb();
    if (!(owner as unknown as { _connected?: boolean })._connected) { await owner.connect(); (owner as unknown as { _connected?: boolean })._connected = true; }
    tenant = randomUUID();
    await adminQuery("INSERT INTO organizations (id, name) VALUES ($1,'P')", [tenant]);
    await ev("old-done", "done", 100); await ev("old-skipped", "skipped", 100); await ev("new-done", "done", 10);
    await ev("old-dead", "dead", 400); await ev("old-failed", "failed", 400); await ev("old-live", "in_progress", 400);
    await dl("replayed-old", 100); await dl("replayed-new", 5); await dl("open-old", null);
  });
  afterAll(async () => { await owner.end().catch(() => undefined); });

  it("dry run counts but deletes nothing", async () => {
    expect(await prune(owner, {})).toEqual({ integration_events: 2, dead_letters: 1 });
    expect((await keys("e")).length).toBe(6);
    expect((await keys("d")).length).toBe(3);
  });
  it("apply deletes only finished events and replayed dead letters past the window", async () => {
    expect(await prune(owner, { apply: true })).toEqual({ integration_events: 2, dead_letters: 1 });
    expect(await keys("e")).toEqual(["new-done", "old-dead", "old-failed", "old-live"]);
    expect(await keys("d")).toEqual(["open-old", "replayed-new"]);
  });
  it("batches, and rejects bad numbers", async () => {
    expect(await prune(owner, { apply: true, batch: 1 })).toEqual({ integration_events: 2, dead_letters: 1 });
    await expect(prune(owner, { batch: 0 })).rejects.toThrow(/positive integer/);
  });
});
