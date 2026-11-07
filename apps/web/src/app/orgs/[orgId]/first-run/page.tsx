import { firstRunFor, readPackId } from "@wos/core";
import { withTenant } from "@wos/db";
import { ActionButton } from "../../../actions";
import { orgContext } from "@/server/org-context";
import { Card, MockBadge, PageTitle, quietButtonCls } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function FirstRunPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const packId = await withTenant(orgId, (tx) => readPackId(tx)) ?? "general";
  const script = await firstRunFor({ actorUserId: userId, orgId, businessName: org.name, packId });
  return (
    <div className="flex flex-col gap-10">
      <PageTitle sub="A practice run with made-up details. Nothing here texts a customer or spends money.">Your first 10 minutes</PageTitle>
      <Card>
        <div className="flex flex-col gap-4">
          <MockBadge />
          <h2 className="text-xl font-semibold">A new lead</h2>
          <p className="text-lg">{script.lead.text}</p>
          <p className="rounded-2xl border border-line bg-canvas px-5 py-4 text-lg">{script.lead.draft}</p>
          <p className="text-base text-muted">This stays a draft until you approve it on Approvals. Approve once sends a MOCK reply only.</p>
        </div>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Here&apos;s your business, as I see it</h2>
        <p className="mt-2 text-lg">{script.business.name}</p>
        <ul className="mt-4 flex flex-col gap-2 text-lg">
          {script.business.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {script.practiceMemoryId ? (
          <p className="mt-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex min-h-10 items-center rounded-full border border-accent/40 bg-accent-soft px-4 text-base">Remembered: example prices are not quotes</span>
            <ActionButton path="kimi.undoPractice" input={{ orgId, memoryId: script.practiceMemoryId }} label="Undo" variant="quiet" confirm="Forget that example prices are not quotes?" />
          </p>
        ) : (
          <p className="mt-4 text-base text-muted">Example prices are not quotes.</p>
        )}
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Today&apos;s brief</h2>
        <ul className="mt-4 flex flex-col gap-3">
          {script.brief.lines.map((line) => (
            <li key={line.text} className="flex flex-col gap-3 rounded-2xl border border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-lg">{line.text}</span>
              {line.action.startsWith("Open") ? (
                <a href={`/orgs/${orgId}/routines`} className={quietButtonCls}>Open the schedule</a>
              ) : (
                <ActionButton path="memory.add" input={{ orgId, content: `${line.text}. ${line.action}. Nothing is sent.` }} label={line.action} variant="quiet" />
              )}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-base text-muted">The practice reply is waiting on Approvals. It expires within the hour and nothing is sent until you approve it.</p>
        <a href={`/orgs/${orgId}/approvals`} className={`${quietButtonCls} mt-3`}>Review the practice reply</a>
      </Card>
      <Card>
        <div className="flex flex-col gap-3">
          <MockBadge />
          <h2 className="text-xl font-semibold">Text Scout — demo</h2>
          <p className="text-lg text-muted">This panel does not use your phone. SMS stays MOCK.</p>
          <p className="rounded-2xl bg-canvas px-5 py-4 text-lg">{script.textDemo.reply}</p>
        </div>
      </Card>
    </div>
  );
}
