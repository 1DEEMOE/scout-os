import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { AppError, createOrg, csvField, exportAuditCsv, inviteMember, listAuditEvents, recordAudit, stopBoss } from "../src/index";
import { withTenant } from "@wos/db";
import { resetDb, seedUser } from "../../db/test/helpers";

let orgId: string;

async function expectCode(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

beforeEach(async () => {
  await resetDb();
  for (const u of ["owner", "member", "outsider"]) await seedUser(u, `${u}@example.test`);
  orgId = (await createOrg({ actorUserId: "owner", name: "Audit Co" })).orgId;
  await inviteMember({ actorUserId: "owner", orgId, email: "member@example.test", role: "member" });
  await withTenant(orgId, async (tx) => {
    for (let i = 0; i < 5; i++) {
      await recordAudit(tx, { tenantId: orgId, actorType: "agent", actorId: "a1", action: `tool.mock.n${i}`, outcome: i === 3 ? "error" : "success", metadata: { note: i === 4 ? "=HYPERLINK(\"http://evil\")" : "ok" } });
    }
  });
});

afterAll(async () => {
  await stopBoss();
  await closePool();
});

describe("audit log viewer", () => {
  it("lists newest first in a stable order, filters, and pages by sequence", async () => {
    const all = await listAuditEvents({ actorUserId: "owner", orgId });
    expect(all.map((e) => e.action)).toEqual(["tool.mock.n4", "tool.mock.n3", "tool.mock.n2", "tool.mock.n1", "tool.mock.n0", "org.invite", "org.create"]);
    expect((await listAuditEvents({ actorUserId: "owner", orgId, actionPrefix: "tool." })).length).toBe(5);
    expect((await listAuditEvents({ actorUserId: "owner", orgId, outcome: "error" })).map((e) => e.action)).toEqual(["tool.mock.n3"]);
    const page2 = await listAuditEvents({ actorUserId: "owner", orgId, beforeSeq: all[2]!.seq, limit: 2 });
    expect(page2.map((e) => e.action)).toEqual(["tool.mock.n1", "tool.mock.n0"]);
    // LIKE wildcards in the filter are literal.
    expect(await listAuditEvents({ actorUserId: "owner", orgId, actionPrefix: "%" })).toEqual([]);
  });

  it("is for owners and admins only, and invisible to other orgs", async () => {
    await expectCode(listAuditEvents({ actorUserId: "member", orgId }), "FORBIDDEN");
    await expectCode(listAuditEvents({ actorUserId: "outsider", orgId }), "NOT_FOUND");
  });

  it("exports CSV with formula injection defused", async () => {
    const csv = await exportAuditCsv({ actorUserId: "owner", orgId });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("seq,at,actor_type,actor_id,action,target,tier,outcome,approval_request_id,metadata,prev_hash,entry_hash");
    expect(lines).toHaveLength(8);
    expect(csvField("=1+1")).toBe(`"'=1+1"`);
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });
});
