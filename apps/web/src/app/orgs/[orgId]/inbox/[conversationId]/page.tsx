import { notFound } from "next/navigation";
import { AppError, getConversation } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../../actions";
import { Badge, Card, PageTitle, When } from "../../../../ui";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ orgId: string; conversationId: string }> }) {
  const { orgId, conversationId } = await params;
  const { userId, org } = await orgContext(orgId);
  let data;
  try {
    data = await getConversation({ actorUserId: userId, orgId, conversationId });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { conversation: c, messages } = data;
  const staff = org.role !== "viewer";
  return (
    <div className="flex flex-col gap-8">
      <a href={`/orgs/${orgId}/inbox`} className="text-base text-muted underline">← Inbox</a>
      <PageTitle sub={c.category ? <span className="flex flex-wrap items-center gap-2"><Badge>{c.category.replace("_", " ")}</Badge> {c.summary}</span> : "Not sorted yet."}>
        {c.subject || "(no subject)"}
      </PageTitle>

      {c.draftBody && (
        <Card title="Draft reply (saved, not sent)">
          <p className="mb-5 whitespace-pre-wrap text-base leading-relaxed">{c.draftBody}</p>
          {staff && (
            <ActionButton path="inbox.requestSend" input={{ orgId, conversationId: c.id }} label="Send for your OK" variant="primary" redirectToTask={{ orgId }} />
          )}
        </Card>
      )}

      {staff && !c.draftBody && (
        <div className="flex flex-wrap gap-3">
          <ActionButton path="inbox.triage" input={{ orgId, conversationId: c.id }} label="Draft a reply" variant="primary" redirectToTask={{ orgId }} />
          <ActionButton path="crm.qualifyLead" input={{ orgId, conversationId: c.id }} label="Treat as sales lead" redirectToTask={{ orgId }} />
        </div>
      )}
      {staff && c.draftBody && (
        <details>
          <summary className="cursor-pointer text-base text-muted hover:text-ink">More actions</summary>
          <div className="mt-3 flex flex-wrap gap-3">
            <ActionButton path="inbox.triage" input={{ orgId, conversationId: c.id }} label="Redraft reply" redirectToTask={{ orgId }} />
            <ActionButton path="crm.qualifyLead" input={{ orgId, conversationId: c.id }} label="Treat as sales lead" redirectToTask={{ orgId }} />
          </div>
        </details>
      )}

      {messages.map((m) => (
        <Card key={m.id} title={<span className="text-base font-normal"><span className="font-medium">{m.sender}</span> <span className="text-muted">· {m.direction === "inbound" ? "received" : "sent"}</span></span>} actions={<span className="text-sm text-muted"><When date={m.sentAt} /></span>}>
          <p className="whitespace-pre-wrap text-base leading-relaxed">{m.body}</p>
        </Card>
      ))}
    </div>
  );
}
