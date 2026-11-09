import { listDeadLetters } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { notFound } from "next/navigation";
import { Empty, PageTitle } from "../../../ui";
import { ReplayButton } from "./replay";

export const dynamic = "force-dynamic";

/** Dead letters from the event bus. Replay is a manager action and stays tier 1. */
export default async function RecoveryPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager } = await orgContext(orgId);
  if (!isManager) notFound();
  const rows = await listDeadLetters({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="When an integration keeps failing, the event waits here. Replay tries the same level 0–1 step again. It does not send email, texts, or payments.">
        Recovery
      </PageTitle>
      {rows.length === 0 ? (
        <Empty>Nothing is waiting. Failed integration events show up here after their retries are used up.</Empty>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <p className="font-medium">{row.type || "event"}{row.integration ? ` · ${row.integration}` : ""}</p>
                <p className="text-sm text-muted">{row.error || "failed"} · {row.attempts} tries · {row.source}</p>
              </div>
              <ReplayButton orgId={orgId} auditId={row.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
