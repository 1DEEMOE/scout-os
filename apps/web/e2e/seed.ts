import { closePool } from "@wos/db";
import { configureEngine, createAgent, createOrg, createTask, inviteMember, loadScoutDemo, MockLedger, mockTools, ModelRouter, operatorSetPlan, runTask, scoutTools, stopBoss, ToolRegistry, UnconfiguredProvider } from "@wos/core";
import { getAuth } from "../src/server/auth";
import { seedMorningBriefing } from "./briefing-seed";
import { ownerQuery, resetDb } from "../../../packages/db/test/helpers";

const PASSWORD = "e2e-password-12345";

// Empty the e2e database (owner role; TRUNCATE ignores RLS).
process.env.DATABASE_URL_OWNER = process.env.E2E_OWNER_DATABASE_URL ?? process.env.DATABASE_URL_OWNER ?? "postgres://wos_owner:owner_dev_pw@localhost:5432/wos_e2e";
await resetDb();

const auth = getAuth();
const ownerUser = await auth.api.signUpEmail({ body: { name: "Olivia Owner", email: "owner@e2e.test", password: PASSWORD } });
await auth.api.signUpEmail({ body: { name: "Victor Viewer", email: "viewer@e2e.test", password: PASSWORD } });
// A second owner (tier 4 needs a different owner to confirm) and a member who asks for the work
// (whoever asks can't approve their own request while another manager exists).
await auth.api.signUpEmail({ body: { name: "Omar Owner", email: "owner2@e2e.test", password: PASSWORD } });
const member = await auth.api.signUpEmail({ body: { name: "Sam Lee", email: "sam@e2e.test", password: PASSWORD } });
// The operator (Darian's role): creates client workspaces from /admin/clients.
await auth.api.signUpEmail({ body: { name: "Dana Operator", email: "ops@e2e.test", password: PASSWORD } });
await ownerQuery("UPDATE users SET email_verified = true WHERE email = 'ops@e2e.test'");
const userId = ownerUser.user.id;
const samId = member.user.id;

configureEngine({ router: new ModelRouter([new UnconfiguredProvider()], "none"), tools: new ToolRegistry().register(...mockTools(new MockLedger()), ...scoutTools()) });
const { orgId } = await createOrg({ actorUserId: userId, name: "E2E Bookkeeping (synthetic)" });
await inviteMember({ actorUserId: userId, orgId, email: "viewer@e2e.test", role: "viewer" });
await inviteMember({ actorUserId: userId, orgId, email: "owner2@e2e.test", role: "owner" });
await inviteMember({ actorUserId: userId, orgId, email: "sam@e2e.test", role: "member" });
await createAgent({ actorUserId: userId, orgId, spec: { kind: "inbox", displayName: "Inbox assistant", instructions: "MOCK", tools: [
  { name: "mock.send_email", maxTier: 2 }, { name: "mock.delete_contact", maxTier: 4 }] } });

// Direct plans: deterministic regardless of which process runs the task.
const email = await createTask({ actorUserId: samId, orgId, intent: "Email the client about their invoice",
  direct: { agentKind: "inbox", steps: [{ tool: "mock.send_email", args: { to: "client@customer.test", subject: "Your invoice", body: "Attached." } }] } });
const del = await createTask({ actorUserId: samId, orgId, intent: "Delete the duplicate contact",
  direct: { agentKind: "inbox", steps: [{ tool: "mock.delete_contact", args: { contactId: "c_duplicate" } }] } });
// One the owner asked for themselves: they must not be offered Approve on it.
const own = await createTask({ actorUserId: userId, orgId, intent: "Email the bank about the new account",
  direct: { agentKind: "inbox", steps: [{ tool: "mock.send_email", args: { to: "bank@example.test", subject: "New account", body: "Hello." } }] } });
await runTask(orgId, email.taskId);
await runTask(orgId, del.taskId);
await runTask(orgId, own.taskId);

// A second org on Scout Pro with labelled DEMO data for the Scout pages.
const scout = await createOrg({ actorUserId: userId, name: "E2E Roofing (synthetic)" });
await inviteMember({ actorUserId: userId, orgId: scout.orgId, email: "sam@e2e.test", role: "member" });
await inviteMember({ actorUserId: userId, orgId: scout.orgId, email: "viewer@e2e.test", role: "viewer" });
await operatorSetPlan(scout.orgId, "scout_pro", "e2e seed");
await loadScoutDemo({ actorUserId: userId, orgId: scout.orgId });
// A real, generated morning briefing for the roofing org (Today leads with it).
await seedMorningBriefing({ actorUserId: userId, orgId: scout.orgId, timezone: "America/Chicago" });
await stopBoss();
await closePool();
console.log(JSON.stringify({ orgId, scoutOrgId: scout.orgId, emailTaskId: email.taskId, deleteTaskId: del.taskId, password: PASSWORD }));
