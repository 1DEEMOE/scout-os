import { listThreads } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { modelStatus } from "@/server/engine";
import { Empty, MockBadge, PageTitle, When } from "../../../ui";
import { Composer } from "../composer";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const threads = await listThreads({ actorUserId: userId, orgId });
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10">
      <PageTitle sub="Every conversation with Scout. It hands work to your teammates; anything external still waits for your OK.">
        Chat {modelStatus() === "mock" && <MockBadge />}
      </PageTitle>
      {org.role !== "viewer" && <Composer orgId={orgId} />}
      {threads.length === 0 ? (
        <Empty>No conversations yet. Ask Scout something above to start one.</Empty>
      ) : (
        <ul aria-label="Conversations" className="flex flex-col gap-2">
          {threads.map((t) => (
            <li key={t.id}>
              <a href={`/orgs/${orgId}/chat/${t.id}`} className="flex min-h-14 items-center justify-between gap-4 rounded-2xl border border-line bg-surface px-5 py-3 transition-colors duration-150 hover:bg-soft">
                <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                <span className="shrink-0 text-sm text-muted"><When date={t.updatedAt} /></span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
