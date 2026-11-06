import { approvalsForReview, getEngine, type ApprovalForReview } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../actions";
import { fieldList } from "../../../field-labels";
import { Badge, Card, Empty, LevelsLegend, MockBadge, NeedOkBadge, OwnerOnlyBadge, PageTitle, TierBadge, When } from "../../../ui";

export const dynamic = "force-dynamic";

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const STATUS_TONE: Record<string, "muted" | "accent" | "danger" | "warn"> = { consumed: "accent", approved: "warn", rejected: "danger", expired: "muted" };

const STATUS_LABEL: Record<string, string> = {
  consumed: "approved and run",
  approved: "approved, not run yet",
  rejected: "declined",
  expired: "expired",
};

function OpenCard({ item, orgId, mockTool }: { item: ApprovalForReview; orgId: string; mockTool: boolean }) {
  const a = item.approval;
  const r = item.reviewer;
  return (
    <Card>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <TierBadge tier={a.tier} />
          <NeedOkBadge tier={a.tier} />
          {item.ownerOnly && <OwnerOnlyBadge />}
          {mockTool && <MockBadge />}
        </div>
        <h2 className="text-xl font-semibold leading-snug tracking-tight">{item.headline}</h2>

        {/* Always-visible safety facts: what / who / amount / source context */}
        <ul className="space-y-2 text-base">
          {item.context.map((l, i) => (
            <li key={`${l.label}-${i}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="w-36 shrink-0 text-muted">{l.label}</span>
              <span className="font-medium">{l.value}</span>
            </li>
          ))}
          <li className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <span className="w-36 shrink-0 text-muted">Asked for by</span>
            <span className="font-medium">
              {item.requestedByName}
              {item.fromChat && (
                <>
                  {" "}
                  via chat in <a className="inline-flex min-h-6 items-center underline underline-offset-4" href={`/orgs/${orgId}/chat/${item.fromChat.threadId}`}>{item.fromChat.title}</a>
                </>
              )}
            </span>
          </li>
        </ul>

        {item.externalDataFields.length > 0 && (
          <p role="note" className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-base">
            <strong>Check the details.</strong> {capitalize(fieldList(item.externalDataFields))}{" "}
            {item.externalDataFields.length === 1 ? "was" : "were"} copied from an email or chat message, which anyone can write. That&apos;s why this needs your OK even though the action itself is lower risk.
          </p>
        )}

        {item.otherOpenInTask > 0 && (
          <p className="text-base text-muted">
            This task has {item.otherOpenInTask} other item{item.otherOpenInTask === 1 ? "" : "s"} waiting. It runs once all are approved.
          </p>
        )}

        {/* One primary pair: OK / Decline */}
        {r.kind === "can_approve" && (
          <div className="flex flex-col gap-3 border-t border-line pt-5">
            {r.note && <p className="text-base text-muted">{r.note}</p>}
            <div className="flex flex-wrap gap-3">
              <ActionButton
                path="approval.decide"
                input={{ orgId, approvalId: a.id, decision: "approve" }}
                label={a.tier === 4 ? "OK (needs second person)" : "OK"}
                variant="primary"
              />
              <ActionButton path="approval.decide" input={{ orgId, approvalId: a.id, decision: "reject" }} label="Decline" />
            </div>
          </div>
        )}
        {r.kind === "can_confirm" && (
          <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center">
            <span className="text-base">Approved once by {item.decidedByName}. This is destructive, so it needs your separate confirmation.</span>
            <ActionButton path="approval.confirm" input={{ orgId, approvalId: a.id }} label="Confirm and run" variant="danger" confirm="This cannot be undone. Confirm?" />
          </div>
        )}
        {r.kind === "read_only" && r.reason && <p className="text-base text-muted">{r.reason}</p>}

        <details className="border-t border-line pt-4">
          <summary className="cursor-pointer text-base text-muted hover:text-ink">Technical details</summary>
          <div className="mt-3 space-y-3 text-base">
            <div className="flex flex-wrap items-center gap-2">
              <TierBadge tier={a.tier} />
              <span className="text-muted">Expires <When date={a.expiresAt} /></span>
            </div>
            <p>
              Task: <a className="inline-flex min-h-6 items-center underline underline-offset-4" href={`/orgs/${orgId}/tasks/${item.taskId}`}>{item.taskTitle}</a>
            </p>
            {item.decidedByName && a.status === "awaiting_confirmation" && (
              <p>First approval: {item.decidedByName} · <When date={a.decidedAt} /></p>
            )}
            <p className="text-muted">
              Action <span className="font-mono text-sm">{a.toolName}</span>
            </p>
            <pre className="max-h-80 overflow-auto rounded-lg bg-line/30 p-4 text-sm break-words whitespace-pre-wrap">
              {JSON.stringify((a.payload as { args?: unknown }).args, null, 2)}
            </pre>
            <p className="text-sm text-muted">If anything in this action changes after you approve, the approval no longer counts and it won&apos;t run.</p>
          </div>
        </details>
      </div>
    </Card>
  );
}

export default async function ApprovalsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId } = await orgContext(orgId);
  const { open, recent } = await approvalsForReview({ actorUserId: userId, orgId });
  const tools = getEngine().tools;

  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Every send, payment, or risky change waits here. What you OK is exactly what runs.">
        Needs your OK {open.length > 0 && <Badge tone="warn">{open.length} waiting</Badge>}
      </PageTitle>
      <details className="group rounded-[var(--radius-card)] border border-line bg-surface px-6 py-2">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
          What the approval levels mean
          <span aria-hidden className="text-muted transition-transform duration-200 group-open:rotate-180">⌄</span>
        </summary>
        <div className="pt-2 pb-5">
          <LevelsLegend highlight={[...new Set(open.map((o) => o.approval.tier))]} />
          <p className="mt-4 text-small text-muted">
            Anything that came from an email or chat message always waits for an OK. Routines run at levels 0–1 only. Bank-detail changes, invoices held as possibly forged and Scout&apos;s first message to a prospect are owner only. Nothing is ever paid automatically.
          </p>
        </div>
      </details>
      {open.length === 0 && (
        <Empty action={<a className="inline-flex min-h-11 items-center font-medium text-accent underline" href={`/orgs/${orgId}`}>Back to Today</a>}>
          Nothing is waiting. You&apos;re clear.
        </Empty>
      )}
      {open.map((item) => (
        <OpenCard key={item.approval.id} item={item} orgId={orgId} mockTool={!!tools.get(item.approval.toolName)?.mock} />
      ))}
      {recent.length > 0 && (
        <Card title="Recently decided">
          <ul className="divide-y divide-line">
            {recent.map((item) => {
              const a = item.approval;
              const ctx = item.context.find((l) => l.label === "Customer" || l.label === "Deal" || l.label === "Email thread");
              return (
                <li key={a.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <span className="min-w-0 text-base">
                    {item.headline}
                    {ctx && ctx.label !== "Customer" && <span className="text-muted"> · {ctx.value}</span>}
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-2 text-muted">
                    <Badge tone={STATUS_TONE[a.status] ?? "muted"}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                    {item.decidedByName && <span className="text-sm">by {item.decidedByName}</span>}
                    <When date={a.decidedAt ?? a.requestedAt} />
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
