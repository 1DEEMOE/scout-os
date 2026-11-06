import { listThreads } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { modelStatus } from "@/server/engine";
import { ActionForm } from "../../../actions";
import { Card, Empty, inputCls, MockBadge, PageTitle, When } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const threads = await listThreads({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-6">
      <PageTitle sub="Talk to your lead bot. It hands work to your AI employees; anything external still waits for approval.">
        Chat {modelStatus() === "mock" && <MockBadge />}
      </PageTitle>
      {org.role !== "viewer" && (
        <Card title="New conversation">
          <ActionForm path="chat.createThread" fixed={{ orgId }} submitLabel="Start" redirectToThread={{ orgId }}>
            <input name="title" required maxLength={200} placeholder="e.g. This week's follow-ups" className={inputCls} />
          </ActionForm>
        </Card>
      )}
      {threads.length === 0 ? (
        <Empty>No conversations yet.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {threads.map((t) => (
            <li key={t.id}>
              <a href={`/orgs/${orgId}/chat/${t.id}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-line/40">
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <When date={t.updatedAt} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
