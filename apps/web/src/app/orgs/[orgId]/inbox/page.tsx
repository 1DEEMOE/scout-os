import { listConversations, listMailboxes } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../actions";
import { Badge, Empty, PageTitle, When } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function InboxPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const [boxes, convs] = await Promise.all([listMailboxes({ actorUserId: userId, orgId }), listConversations({ actorUserId: userId, orgId })]);
  const box = boxes[0];
  const draftReady = convs.filter((c) => c.draftBody).length;
  return (
    <div className="flex flex-col gap-8">
      <PageTitle
        sub={
          box
            ? <>{box.address} · {box.mode === "draft_only" ? "drafts only (nothing sends by itself)" : "sending allowed after your OK"} · last synced <When date={box.lastSyncedAt} /></>
            : "No mailbox connected yet."
        }
      >
        Inbox {draftReady > 0 && <Badge tone="accent">{draftReady} draft{draftReady === 1 ? "" : "s"} ready</Badge>}
      </PageTitle>
      {!box ? (
        <Empty action={<a className="accent-fill rounded-lg bg-accent px-5 py-2.5 text-base font-medium text-on-accent" href={`/orgs/${orgId}/settings`}>Connect mailbox</a>}>
          Connect Gmail in Settings to sort email and draft replies.
        </Empty>
      ) : (
        org.role !== "viewer" && <ActionButton path="inbox.sync" input={{ orgId }} label="Refresh mail" busyLabel="Refreshing…" />
      )}
      {convs.length === 0 && box ? (
        <Empty>No conversations yet. Refresh mail after connecting a mailbox.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-sm">
          {convs.map((c) => (
            <li key={c.id}>
              <a href={`/orgs/${orgId}/inbox/${c.id}`} className="flex flex-col gap-2 px-5 py-5 hover:bg-line/30 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-medium">{c.subject || "(no subject)"}</span>
                  {c.summary && <span className="mt-1 block truncate text-base text-muted">{c.summary}</span>}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-base">
                  {c.category && <Badge>{c.category.replace("_", " ")}</Badge>}
                  {c.draftBody && <Badge tone="accent">draft ready</Badge>}
                  <When date={c.lastMessageAt} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
