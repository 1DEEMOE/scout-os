// Milestone 3 acceptance with a MOCK mailbox (no Google account available):
// 10 synthetic emails -> sync -> triage -> drafts -> one send via approval.
// The same flow against real Gmail is in docs/plans/live-integration-runbook.md.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closePool, emailIdentities, withGlobal, withTenant } from "@wos/db";
import {
  configureEngine, connectGoogleMailbox, createAgent, createOrg, decideApproval, FakeMailProvider, inboxTools, listApprovals,
  listConversations, MockModelProvider, ModelRouter, requestSendDraft, runTask, setMailboxMode, stopBoss, syncInbox, ToolRegistry,
  triageConversation, type MailboxResolver,
} from "../src/index";

const mail = new FakeMailProvider();
const resolver: MailboxResolver = async (t) => {
  const [identity] = await withTenant(t, (tx) => tx.select().from(emailIdentities));
  return identity ? { provider: mail, identity } : null;
};
const categories = ["billing", "lead", "client_request", "scheduling", "vendor"] as const;
configureEngine({
  router: new ModelRouter([new MockModelProvider((r) => {
    if (r.purpose === "classify") return { text: "inbox" };
    const id = /Conversation id: ([0-9a-f-]{36})/.exec(r.messages[0]!.content)![1]!;
    const n = Number(/msg-(\d+)/.exec(r.messages[0]!.content)?.[1] ?? 0);
    return { toolCalls: [
      { name: "inbox.categorize", input: { conversationId: id, category: categories[n % 5], summary: "MOCK summary" } },
      { name: "inbox.create_draft", input: { conversationId: id, body: `Thanks for your note. (MOCK draft ${n})` } },
    ] };
  })], "mock"),
  tools: new ToolRegistry().register(...inboxTools(resolver)),
  mailbox: resolver,
});

const user = `accept-${randomUUID().slice(0, 8)}`;
await withGlobal((tx) => tx.execute(sql`INSERT INTO users (id, name, email) VALUES (${user}, 'Owner', ${user + "@example.test"})`));
const { orgId } = await createOrg({ actorUserId: user, name: "M3 Acceptance (synthetic)" });
await createAgent({ actorUserId: user, orgId, spec: { kind: "inbox", displayName: "Inbox", instructions: "Triage.", tools: [
  { name: "inbox.categorize", maxTier: 1 }, { name: "inbox.create_draft", maxTier: 1 }, { name: "inbox.send_draft", maxTier: 2 }] } });
await connectGoogleMailbox({ actorUserId: user, orgId, address: "office@acme.test", tokens: { refresh_token: "MOCK" }, scopes: [] });
for (let i = 1; i <= 10; i++) {
  mail.inbox.push({ externalId: `msg-${i}`, threadId: `thr-${i}`, from: `client${i}@customer.test`, to: ["office@acme.test"], subject: `Question ${i}`, body: `Synthetic email msg-${i}`, sentAt: new Date(), direction: "inbound" });
}
console.log("sync:", await syncInbox({ actorUserId: user, orgId }));
for (const c of await listConversations({ actorUserId: user, orgId })) {
  const { taskId } = await triageConversation({ actorUserId: user, orgId, conversationId: c.id });
  await runTask(orgId, taskId);
}
const convs = await listConversations({ actorUserId: user, orgId });
console.log(`triaged: ${convs.filter((c) => c.category).length}/10, drafts: ${convs.filter((c) => c.draftBody).length}/10, MOCK drafts in mailbox: ${mail.drafts.size}, sent: ${mail.sent.size}`);

const [ident] = await withTenant(orgId, (tx) => tx.select().from(emailIdentities));
await setMailboxMode({ actorUserId: user, orgId, identityId: ident!.id, mode: "send_with_approval" });
const { taskId } = await requestSendDraft({ actorUserId: user, orgId, conversationId: convs[0]!.id });
console.log("send task:", await runTask(orgId, taskId));
const [ap] = await listApprovals({ actorUserId: user, orgId, status: "pending" });
console.log(`approval shows: ${ap!.summary}`);
await decideApproval({ actorUserId: user, orgId, approvalId: ap!.id, decision: "approve" });
console.log("after approval:", await runTask(orgId, taskId), `| MOCK sent: ${mail.sent.size}`);
const trail = await withTenant(orgId, (tx) => tx.execute(sql`SELECT action, count(*)::int AS n FROM audit_events GROUP BY action ORDER BY action`));
console.log("audit counts:", Object.fromEntries((trail.rows as { action: string; n: number }[]).map((r) => [r.action, r.n])));
await stopBoss();
await closePool();
