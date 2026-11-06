// Fills the e2e database with a realistic synthetic business for screenshots.
// All data is fake; all providers are MOCK. Run: npx tsx e2e/demo-seed.ts
import { emailIdentities, closePool, withTenant } from "@wos/db";
import {
  configureEngine, connectGoogleMailbox, createOrg, createTask, crmTools, decideApproval, FakeCrmProvider, FakeInvoicingProvider,
  FakeMailProvider, financeTools, inboxTools, inviteMember, listConversations, memoryTools, MockModelProvider, ModelRouter,
  provisionRecommendedAgents, qualifyLead, recordModelUsage, rememberFact, requestSendDraft, runTask, setMailboxMode, stopBoss, syncInbox,
  syncInvoices, ToolRegistry, triageConversation, type MailboxResolver, type ModelResponse,
  loadScoutDemo, operatorSetPlan, scoutTools,
} from "@wos/core";
import { getAuth } from "../src/server/auth";
import { ownerQuery, resetDb } from "../../../packages/db/test/helpers";

process.env.DATABASE_URL_OWNER = process.env.E2E_OWNER_DATABASE_URL ?? "postgres://wos_owner:owner_dev_pw@localhost:5432/wos_e2e";
await resetDb();
const auth = getAuth();
const owner = (await auth.api.signUpEmail({ body: { name: "Dana Rivera", email: "owner@e2e.test", password: "e2e-password-12345" } })).user.id;
await auth.api.signUpEmail({ body: { name: "Sam Lee", email: "sam@e2e.test", password: "e2e-password-12345" } });
// MOCK platform operator for /admin/clients. Not a member of the demo business,
// and only created when this process is explicitly in mock mode.
if (process.env.WOS_MOCK_MODE === "1") {
  await auth.api.signUpEmail({ body: { name: "MOCK Platform Admin", email: "mock-admin@e2e.test", password: "e2e-password-12345" } });
  await ownerQuery("UPDATE users SET email_verified = true WHERE email = 'mock-admin@e2e.test'");
}

const mail = new FakeMailProvider();
const crm = new FakeCrmProvider();
const billing = new FakeInvoicingProvider();
const mailbox: MailboxResolver = async (t) => {
  const [identity] = await withTenant(t, (tx) => tx.select().from(emailIdentities));
  return identity ? { provider: mail, identity } : null;
};
let plan: Partial<ModelResponse> = {};
configureEngine({
  router: new ModelRouter([new MockModelProvider((r) => (r.purpose === "classify" ? { text: "inbox" } : plan))], "mock"),
  tools: new ToolRegistry().register(...inboxTools(mailbox), ...crmTools(async () => crm), ...financeTools(async () => billing), ...memoryTools(), ...scoutTools()),
  mailbox, crm: async () => crm, invoicing: async () => billing,
});

const { orgId } = await createOrg({ actorUserId: owner, name: "Rivera Bookkeeping" });
await inviteMember({ actorUserId: owner, orgId, email: "sam@e2e.test", role: "member" });
await provisionRecommendedAgents({ actorUserId: owner, orgId });
await rememberFact({ actorUserId: owner, orgId, content: "We invoice on the 1st; payment is due within 15 days." });
await rememberFact({ actorUserId: owner, orgId, content: "Monthly bookkeeping starts at $450; payroll add-on is $120." });

await connectGoogleMailbox({ actorUserId: owner, orgId, address: "office@riverabooks.test", tokens: { refresh_token: "MOCK" }, scopes: [] });
const emails: [string, string, string][] = [
  ["Maya Chen <maya@chenbakery.test>", "Can you resend October's invoice?", "Hi Dana, I can't find the October invoice in my email. Could you resend it? Thanks, Maya"],
  ["Tom Alvarez <tom@alvarezplumbing.test>", "Quote for monthly bookkeeping", "Hi, we're a 6-person plumbing company and need someone to handle monthly books and payroll. What would that cost?"],
  ["Priya Nair <priya@nairdesign.test>", "Meeting next week?", "Could we meet Tuesday or Wednesday to go over Q3 numbers?"],
  ["Office Supplies Co <billing@officesupplies.test>", "Your order has shipped", "Your order #44821 has shipped and will arrive Thursday."],
];
emails.forEach(([from, subject, body], i) =>
  mail.inbox.push({ externalId: `m${i}`, threadId: `t${i}`, from, to: ["office@riverabooks.test"], subject, body, sentAt: new Date(Date.now() - (i + 1) * 3_600_000), direction: "inbound" }));
await syncInbox({ actorUserId: owner, orgId });
const convs = await listConversations({ actorUserId: owner, orgId });
const by = (s: string) => convs.find((c) => c.subject.startsWith(s))!;

const triage: [string, string, string, string][] = [
  ["Can you resend", "billing", "Maya asks for October's invoice to be resent.", "Hi Maya, of course! I've attached October's invoice. Let me know if you need anything else. Best, Dana"],
  ["Meeting next", "scheduling", "Priya wants to review Q3 numbers Tuesday or Wednesday.", "Hi Priya, Tuesday at 2pm works well. I'll send an invite. Best, Dana"],
  ["Your order", "vendor", "Office supply order #44821 ships Thursday.", ""],
];
for (const [s, category, summary, draft] of triage) {
  const c = by(s);
  plan = { toolCalls: [{ name: "inbox.categorize", input: { conversationId: c.id, category, summary } }, ...(draft ? [{ name: "inbox.create_draft", input: { conversationId: c.id, body: draft } }] : [])] };
  const { taskId } = await triageConversation({ actorUserId: owner, orgId, conversationId: c.id });
  await runTask(orgId, taskId);
}

// The plumbing lead goes to sales.
const lead = by("Quote for");
plan = { toolCalls: [
  { name: "crm.upsert_contact", input: { email: "tom@alvarezplumbing.test", name: "Tom Alvarez", company: "Alvarez Plumbing" } },
  { name: "crm.create_deal", input: { name: "Alvarez Plumbing: books + payroll", contactEmail: "tom@alvarezplumbing.test" } },
  { name: "crm.add_note", input: { contactEmail: "tom@alvarezplumbing.test", body: "6 staff; wants monthly bookkeeping and payroll." } },
  { name: "inbox.create_draft", input: { conversationId: lead.id, body: "Hi Tom, thanks for reaching out! Monthly bookkeeping starts at $450, and payroll for 6 people adds $120. Could we set up a 20-minute call this week?" } },
] };
// The lead's address came from the email (G7), so the CRM steps wait for a human. Approve them
// (the owner is the only manager here, so this is the audited sole-manager waiver).
const leadTask = (await qualifyLead({ actorUserId: owner, orgId, conversationId: lead.id })).taskId;
let leadState = await runTask(orgId, leadTask);
if (leadState === "WAITING_FOR_APPROVAL") {
  const { listApprovals: pending } = await import("@wos/core");
  for (const a of (await pending({ actorUserId: owner, orgId, status: "pending" })).filter((x) => x.taskId === leadTask)) {
    await decideApproval({ actorUserId: owner, orgId, approvalId: a.id, decision: "approve" });
  }
  leadState = await runTask(orgId, leadTask);
}
if (leadState !== "COMPLETED") throw new Error(`lead task ended ${leadState}`);
plan = { toolCalls: [{ name: "inbox.categorize", input: { conversationId: lead.id, category: "lead", summary: "Plumbing company (6 staff) wants a bookkeeping and payroll quote." } }] };
await runTask(orgId, (await triageConversation({ actorUserId: owner, orgId, conversationId: lead.id })).taskId);

// Pending approvals: a reply to send (tier 2), a deal amount (tier 3), an invoice (tier 3).
const [ident] = await withTenant(orgId, (tx) => tx.select().from(emailIdentities));
await setMailboxMode({ actorUserId: owner, orgId, identityId: ident!.id, mode: "send_with_approval" });
await runTask(orgId, (await requestSendDraft({ actorUserId: owner, orgId, conversationId: by("Can you resend").id })).taskId);
const deal = (await withTenant(orgId, (tx) => tx.query.crmRecords.findFirst()))!;
const priced = await createTask({ actorUserId: owner, orgId, intent: "Set the Alvarez deal to $570/month",
  direct: { agentKind: "sales", steps: [{ tool: "crm.set_deal_amount", args: { dealId: deal.id, amountCents: 57000 } }] } });
await runTask(orgId, priced.taskId);

// Invoices: two overdue, one current, one paid; reminders proposed for the overdue ones.
const add = (id: string, name: string, email: string, cents: number, due: string, status: "open" | "paid" = "open") =>
  billing.invoices.set(id, { externalId: id, number: `RB-${id.slice(-3)}`, customerName: name, customerEmail: email, status, amountDueCents: cents, currency: "usd", dueDate: due });
add("in_101", "Chen Bakery", "maya@chenbakery.test", 45000, "2026-10-15");
add("in_102", "Nair Design", "priya@nairdesign.test", 57000, "2026-10-22");
add("in_103", "Gomez Landscaping", "ana@gomezland.test", 45000, "2026-11-15");
add("in_104", "Patel Dental", "raj@pateldental.test", 69000, "2026-10-01", "paid");
await syncInvoices({ actorUserId: owner, orgId });
const { chaseOverdue } = await import("@wos/core");
const overdue = await (await import("@wos/core")).findOverdue({ actorUserId: owner, orgId });
plan = { toolCalls: overdue.map((i) => ({ name: "finance.send_invoice_reminder", input: { invoiceId: i.id } })) };
const chase = await chaseOverdue({ actorUserId: owner, orgId });
await runTask(orgId, chase.taskId!);
// Approve one reminder so the history shows a decision.
const { listApprovals } = await import("@wos/core");
const reminder = (await listApprovals({ actorUserId: owner, orgId, status: "pending" })).find((a) => a.toolName === "finance.send_invoice_reminder")!;
await decideApproval({ actorUserId: owner, orgId, approvalId: reminder.id, decision: "approve" });

// A month of model usage, so Billing has numbers (synthetic tokens at the configured prices).
for (let i = 0; i < 38; i++) {
  await recordModelUsage({ purpose: "plan", tenantId: orgId, system: "", messages: [] },
    { text: "", toolCalls: [], usage: { inputTokens: 2500 + i * 40, outputTokens: 400 }, provider: "anthropic", model: "claude-sonnet-5-5" });
}
// A roofing company on Scout Pro with labelled DEMO Scout data.
const roofing = await createOrg({ actorUserId: owner, name: "Rivera Roofing (DEMO)" });
await inviteMember({ actorUserId: owner, orgId: roofing.orgId, email: "sam@e2e.test", role: "member" });
await operatorSetPlan(roofing.orgId, "scout_pro", "demo seed");
await loadScoutDemo({ actorUserId: owner, orgId: roofing.orgId });

await stopBoss();
await closePool();
console.log(JSON.stringify({ orgId, scoutOrgId: roofing.orgId, conversationId: by("Can you resend").id, taskId: priced.taskId }));
