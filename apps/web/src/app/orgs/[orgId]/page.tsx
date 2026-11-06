import {
  approvalsForReview,
  findOverdue,
  latestBriefing,
  latestAiAnswersCheck,
  listFlaggedDocuments,
  listFlaggedPaymentChanges,
  formatRiskFlags,
  listPendingFrontDeskBookings,
  listTasks,
  taskLabel,
  type ApprovalForReview,
  type Briefing,
} from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../actions";
import { Badge, Card, Empty, money, NeedOkBadge, PageTitle, StateBadge, When } from "../../ui";
import { OnboardingChecklist } from "./onboarding-checklist";
import { PaymentCallbackForm } from "./payment-callback-form";
import { fmtIn } from "./routines/parts";

export const dynamic = "force-dynamic";

function ApproveStrip({ item, orgId }: { item: ApprovalForReview; orgId: string }) {
  const a = item.approval;
  const r = item.reviewer;
  return (
    <li className="flex flex-col gap-4 border-b border-line py-5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <NeedOkBadge tier={a.tier} />
          <span className="text-sm text-muted">from {item.requestedByName}</span>
        </div>
        <p className="text-lg font-medium leading-snug">{item.headline}</p>
        <ul className="space-y-1 text-base text-muted">
          {item.context.slice(0, 4).map((l, i) => (
            <li key={`${l.label}-${i}`}>
              <span className="text-muted">{l.label}:</span> <span className="text-ink">{l.value}</span>
            </li>
          ))}
        </ul>
        <details className="text-base">
          <summary className="cursor-pointer text-muted hover:text-ink">More details</summary>
          <dl className="mt-3 grid gap-2 sm:grid-cols-[8rem_1fr]">
            {item.context.map((l, i) => (
              <div key={`d-${l.label}-${i}`} className="contents">
                <dt className="text-muted">{l.label}</dt>
                <dd className="font-medium">{l.value}</dd>
              </div>
            ))}
            <dt className="text-muted">Task</dt>
            <dd>
              <a className="underline" href={`/orgs/${orgId}/tasks/${item.taskId}`}>{item.taskTitle}</a>
            </dd>
            <dt className="text-muted">Risk</dt>
            <dd>Level {a.tier}</dd>
            <dt className="text-muted">Expires</dt>
            <dd><When date={a.expiresAt} /></dd>
          </dl>
        </details>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
        {r.kind === "can_approve" && (
          <div className="flex flex-wrap gap-2">
            <ActionButton
              path="approval.decide"
              input={{ orgId, approvalId: a.id, decision: "approve" }}
              label={a.tier === 4 ? "OK (needs second person)" : "OK"}
              variant="primary"
            />
            <ActionButton path="approval.decide" input={{ orgId, approvalId: a.id, decision: "reject" }} label="Decline" />
          </div>
        )}
        {r.kind === "can_confirm" && (
          <ActionButton path="approval.confirm" input={{ orgId, approvalId: a.id }} label="Confirm and run" variant="danger" confirm="This cannot be undone. Confirm?" />
        )}
        {r.kind === "read_only" && r.reason && <p className="max-w-xs text-sm text-muted">{r.reason}</p>}
      </div>
    </li>
  );
}

export default async function TodayPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const staff = org.role !== "viewer";
  const [review, tasks, overdue, latest, paymentFlags, frontDesk, flaggedDocs, aiCheck] = await Promise.all([
    approvalsForReview({ actorUserId: userId, orgId }),
    listTasks({ actorUserId: userId, orgId, limit: 100 }),
    findOverdue({ actorUserId: userId, orgId }),
    latestBriefing({ actorUserId: userId, orgId }),
    listFlaggedPaymentChanges({ actorUserId: userId, orgId }),
    listPendingFrontDeskBookings({ actorUserId: userId, orgId }),
    listFlaggedDocuments({ actorUserId: userId, orgId }),
    latestAiAnswersCheck({ actorUserId: userId, orgId }),
  ]);
  const open = review.open;
  const briefing = latest?.run.output as Briefing | undefined;
  const attention = tasks.filter((t) => t.state === "ESCALATED" || t.state === "FAILED").slice(0, 5);
  const waitingTasks = tasks.filter((t) => t.state === "WAITING_FOR_APPROVAL").slice(0, 3);
  const overdueTotal = overdue.reduce((s, i) => s + i.amountDueCents, 0);

  return (
    <div className="flex flex-col gap-10">
      <PageTitle sub="Your morning picture: what needs a decision, what’s overdue, and what to do next.">
        Today
      </PageTitle>

      <OnboardingChecklist orgId={orgId} userId={userId} />

      {paymentFlags.length > 0 && (
        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              Bank detail changes <Badge tone="warn">{paymentFlags.length}</Badge>
            </span>
          }
        >
          <p className="mb-4 text-base text-muted">
            Someone asked to change how money is paid. Call the number already on file, record the call-back, then approve. Never use a number from the request.
          </p>
          <ul className="divide-y divide-line">
            {paymentFlags.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p className="text-lg font-medium">{c.label}</p>
                  <p className="text-base text-muted">
                    {c.kind} · account ···{c.accountLast4} · via {c.source}
                    {c.callbackVerifiedAt ? " · call-back recorded" : " · call-back needed"}
                  </p>
                </div>
                <div className="flex w-full flex-col gap-3 sm:max-w-sm sm:items-stretch">
                  {!c.callbackVerifiedAt && staff && (
                    <PaymentCallbackForm orgId={orgId} changeId={c.id} onFilePhoneHint={c.onFilePhoneHint} />
                  )}
                  {c.approvalRequestId && (
                    <a className="text-base font-medium text-accent underline" href={`/orgs/${orgId}/approvals`}>
                      Open approvals
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {frontDesk.length > 0 && (
        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              Front desk bookings <Badge tone="warn">{frontDesk.length}</Badge>
            </span>
          }
          actions={<a className="text-base text-muted underline" href={`/orgs/${orgId}/approvals`}>Review in Approvals</a>}
        >
          <p className="mb-4 text-base text-muted">
            Outside booking requests (people and AI agents) always need your OK before they are confirmed.
          </p>
          <ul className="divide-y divide-line">
            {frontDesk.slice(0, 5).map((b) => (
              <li key={b.id} className="flex flex-col gap-1 py-4">
                <p className="text-lg font-medium">{b.customerName}</p>
                <p className="text-base text-muted">
                  {b.requesterKind === "ai_agent" ? `AI agent · ${b.agentName ?? "unnamed"}` : "Person"}
                  {b.agentProvider ? ` · ${b.agentProvider}` : ""} · waiting for OK
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {flaggedDocs.length > 0 && (
        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              Flagged invoices &amp; estimates <Badge tone="warn">{flaggedDocs.length}</Badge>
            </span>
          }
          actions={<a className="text-base text-muted underline" href={`/orgs/${orgId}/approvals`}>Open approvals</a>}
        >
          <p className="mb-4 text-base text-muted">
            Risk checks found problems. Nothing is paid automatically — review each one.
          </p>
          <ul className="divide-y divide-line">
            {flaggedDocs.slice(0, 5).map((d) => (
              <li key={d.id} className="py-4">
                <p className="text-lg font-medium">{d.vendorName} · {d.kind}</p>
                <p className="text-base text-muted">
                  {formatRiskFlags((d.riskFlags as string[]) ?? []) || "review"} · score {d.riskScore}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {aiCheck && (
        <Card title="AI answers check">
          <p className="text-lg font-medium">
            {aiCheck.recommended ? "Recommended" : "Not clearly recommended"} for {aiCheck.trade} in {aiCheck.zip}
          </p>
          <p className="mt-1 text-base text-muted">
            Score {aiCheck.score}/100 · {aiCheck.period}
            {aiCheck.trendDelta != null ? ` · trend ${aiCheck.trendDelta >= 0 ? "+" : ""}${aiCheck.trendDelta}` : ""}
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-base text-muted">
            {(aiCheck.suggestions as string[]).slice(0, 3).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Card>
      )}

      {open.length > 0 && (
        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              Needs your OK <Badge tone="warn">{open.length}</Badge>
            </span>
          }
          actions={<a className="text-base text-muted underline" href={`/orgs/${orgId}/approvals`}>See all</a>}
        >
          <ul>
            {open.slice(0, 5).map((item) => (
              <ApproveStrip key={item.approval.id} item={item} orgId={orgId} />
            ))}
          </ul>
        </Card>
      )}

      {open.length === 0 && (
        <Card title="Needs your OK">
          <Empty action={<a className="font-medium text-accent underline" href={`/orgs/${orgId}/approvals`}>Open approvals</a>}>
            Nothing waiting. When an agent wants to send, charge, or change something important, it shows up here.
          </Empty>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <a href={`/orgs/${orgId}/finance`} className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-sm hover:border-accent/40">
          <div className="text-3xl font-semibold tabular-nums">{overdue.length}</div>
          <div className="mt-1 text-base text-muted">Overdue invoices · {money(overdueTotal)}</div>
          {staff && overdue.length > 0 && <div className="mt-3 text-base font-medium text-accent">Review &amp; remind →</div>}
        </a>
        <a href={`/orgs/${orgId}/tasks`} className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-sm hover:border-accent/40">
          <div className="text-3xl font-semibold tabular-nums">{waitingTasks.length || tasks.filter((t) => !["COMPLETED", "FAILED"].includes(t.state)).length}</div>
          <div className="mt-1 text-base text-muted">{waitingTasks.length ? "Tasks waiting for your OK" : "Tasks in progress"}</div>
        </a>
        <a href={`/orgs/${orgId}/routines/briefing`} className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-sm hover:border-accent/40">
          <div className="text-3xl font-semibold">{briefing ? "Ready" : "—"}</div>
          <div className="mt-1 text-base text-muted">
            {briefing ? `Briefing · ${fmtIn(briefing.generatedAt, briefing.timezone)}` : "No morning briefing yet"}
          </div>
          <div className="mt-3 text-base font-medium text-accent">{briefing ? "Open briefing →" : "Set up a routine →"}</div>
        </a>
      </div>

      <Card
        title="Morning briefing"
        actions={
          <a className="text-base text-muted underline" href={`/orgs/${orgId}/routines/briefing`}>
            Full view
          </a>
        }
      >
        {!briefing ? (
          <Empty
            action={
              <a className="rounded-lg bg-accent px-5 py-2.5 text-base font-medium text-on-accent" href={`/orgs/${orgId}/routines`}>
                Set up Morning Briefing
              </a>
            }
          >
            Get a daily in-app summary of storm leads, unanswered leads, overdue invoices, and approvals. Nothing is emailed.
          </Empty>
        ) : (
          <div className="flex flex-col gap-6">
            {briefing.sections
              .filter((s) => s.status === "ok" && s.count > 0)
              .slice(0, 4)
              .map((s) => (
                <div key={s.key}>
                  <h3 className="mb-2 text-base font-semibold">
                    {s.title} <span className="font-normal text-muted">({s.count})</span>
                  </h3>
                  <ul className="space-y-2 text-base">
                    {s.items.slice(0, 3).map((it, i) => (
                      <li key={i}>
                        {it.href ? <a className="underline" href={it.href}>{it.label}</a> : it.label}
                        {it.detail && <span className="text-muted"> · {it.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            {briefing.sections.every((s) => s.status !== "ok" || s.count === 0) && (
              <p className="text-base text-muted">All clear in the latest briefing.</p>
            )}
          </div>
        )}
      </Card>

      {attention.length > 0 && (
        <Card title="Needs a look">
          <ul className="divide-y divide-line">
            {attention.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <a className="text-base font-medium underline" href={`/orgs/${orgId}/tasks/${t.id}`}>{taskLabel(t)}</a>
                <span className="flex items-center gap-2">
                  <StateBadge state={t.state} />
                  <When date={t.updatedAt} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Quiet usage link — not a competing KPI wall */}
      <p className="text-sm text-muted">
        <a className="underline" href={`/orgs/${orgId}/billing`}>Plan &amp; AI usage</a>
      </p>
    </div>
  );
}
