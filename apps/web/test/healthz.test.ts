import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { GET } from "../src/app/api/healthz/route";

afterAll(async () => {
  await closePool();
});

describe("/api/healthz", () => {
  it("returns ok when the database answers", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, degraded: [] });
  });
});
