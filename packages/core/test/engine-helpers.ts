import { eq, sql } from "drizzle-orm";
import { approvalRequests, tasks, withTenant } from "@wos/db";
import {
  configureEngine,
  createAgent,
  createOrg,
  inviteMember,
  MockLedger,
  MockModelProvider,
  mockLeadBotPlan,
  mockTools,
  ModelRouter,
  ToolRegistry,
  type ModelRequest,
  type ModelResponse,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

export interface Harness {
  orgId: string;
  ledger: MockLedger;
  model: MockModelProvider;
  /** What the mock model proposes next time it is asked to plan. */
  setPlan(calls: { name: string; input: unknown }[], text?: string): void;
  /** Override the lead bot's next reply (default: the MOCK keyword planner). */
  setLeadPlan(res: Partial<ModelResponse> | null): void;
}

/** Fresh DB, an org with owner/admin/member/viewer, MOCK model and MOCK tools. */
export async function setupHarness(opts: { agentTools?: { name: string; maxTier: number }[] } = {}): Promise<Harness> {
  await resetDb();
  await seedUser("owner", "owner@example.test");
  await seedUser("admin", "admin@example.test");
  await seedUser("member", "member@example.test");
  await seedUser("viewer", "viewer@example.test");
  await seedUser("outsider", "outsider@example.test");

  const ledger = new MockLedger();
  let plan: Partial<ModelResponse> = { toolCalls: [] };
  let leadPlan: Partial<ModelResponse> | null = null;
  const model = new MockModelProvider((req: ModelRequest) =>
    req.purpose === "classify" ? { text: "inbox" } : req.purpose === "lead.plan" ? (leadPlan ?? mockLeadBotPlan(req)) : plan,
  );
  configureEngine({ router: new ModelRouter([model], "mock"), tools: new ToolRegistry().register(...mockTools(ledger)), retryBaseSeconds: 1 });

  const { orgId } = await createOrg({ actorUserId: "owner", name: "Harness Co" });
  for (const [email, role] of [["admin@example.test", "admin"], ["member@example.test", "member"], ["viewer@example.test", "viewer"]] as const) {
    await inviteMember({ actorUserId: "owner", orgId, email, role });
  }
  await createAgent({
    actorUserId: "owner",
    orgId,
    spec: {
      kind: "inbox",
      displayName: "Inbox",
      instructions: "Handle the inbox.",
      tools: opts.agentTools ?? [
        { name: "mock.lookup", maxTier: 0 },
        { name: "mock.note", maxTier: 1 },
        { name: "mock.send_email", maxTier: 2 },
        { name: "mock.charge", maxTier: 3 },
        { name: "mock.delete_contact", maxTier: 4 },
      ],
    },
  });
  return { orgId, ledger, model, setPlan: (toolCalls, text = "") => (plan = { toolCalls, text }), setLeadPlan: (r) => (leadPlan = r) };
}

export async function taskRow(orgId: string, taskId: string) {
  return withTenant(orgId, async (tx) => (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
}

export async function approvalsFor(orgId: string, taskId: string) {
  return withTenant(orgId, (tx) => tx.select().from(approvalRequests).where(eq(approvalRequests.taskId, taskId)));
}

export async function auditActions(orgId: string) {
  const r = await withTenant(orgId, (tx) => tx.execute(sql`SELECT action, outcome, metadata FROM audit_events ORDER BY at, id`));
  return r.rows as { action: string; outcome: string; metadata: Record<string, unknown> }[];
}
