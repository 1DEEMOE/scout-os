import {
  approvalsForReview,
  findOverdue,
  formatRiskFlags,
  latestAiAnswersCheck,
  latestBriefing,
  listFlaggedDocuments,
  listFlaggedPaymentChanges,
  listPendingFrontDeskBookings,
  listTasks,
  taskLabel,
  type Briefing,
} from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Badge, money, StateBadge, When } from "../../ui";
import { ApprovalCard, Panel, ScoutMessage, Transcript } from "./chat-ui";
import { Composer } from "./composer";
import { OnboardingChecklist } from "./onboarding-checklist";
import { PaymentCallbackForm } from "./payment-callback-form";

export const dynamic = "force-dynamic";

const SUGGESTIONS = ["Chase overdue invoices", "Follow up with new leads", "What needs my attention today?"];

/**
 * Today: a conversation with Scout. The morning briefing, anything waiting for
 * approval and anything that needs a look arrive as Scout's messages; the
 * composer at the bottom starts a new conversation.
 */
export default async function TodayPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const staff = org.role !== "viewer";
  const who = { actorUserId: userId, orgId };
  const [review, tasks, overdue, latest, paymentFlags, frontDesk, flaggedDocs, aiCheck] = await Promise.all([
    approvalsForReview(who),
    listTasks({ ...who, limit: 100 }),
    findOverdue(who),
    latestBriefing(who),
    listFlaggedPaymentChanges(who),
    listPendingFrontDeskBookings(who),
    listFlaggedDocuments(who),
    latestAiAnswersCheck(who),
  ]);
  const open = review.open;
  const briefing = latest?.run.output as Briefing | undefined;
  const sections = briefing?.sections.filter((s) => s.status === "ok" && s.count > 0).slice(0, 4) ?? [];
  const attention = tasks.filter((t) => t.state === "ESCALATED" || t.state === "FAILED").slice(0, 5);
  const overdueTotal = overdue.reduce((s, i) => s + i.amountDueCents, 0);
  // The briefing knows the business's time zone; fall back to the server's.
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: briefing?.timezone });

  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      <header className="mb-10">
        <p className="text-muted">{today}</p>
        <h1 className="mt-1 text-[2rem] leading-tight font-semibold">Today</h1>
        <p className="mt-2 text-lg text-muted">Here&apos;s what Scout has for {org.name}.</p>
      </header>

      {staff ? (
        <div className="mb-14">
          <Composer orgId={orgId} suggestions={SUGGESTIONS} />
        </div>
      ) : (
        <p className="mb-12 text-muted">You have view-only access, so you can read but not ask Scout to act.</p>
      )}

      <Transcript label="Today with Scout">
        {staff && <OnboardingChecklist orgId={orgId} userId={userId} />}

        {briefing ? (
          <ScoutMessage id="briefing" at={briefing.generatedAt} title={sections.length ? "Here's your morning briefing." : "Your morning briefing is in, and it's all clear."}>
            {sections.length > 0 && (
              <Panel>
                <div className="flex flex-col gap-6">
                  {sections.map((s) => (
                    <section key={s.key}>
                      <h2 className="mb-2 font-semibold">
                        {s.title} <span className="font-normal text-muted">({s.count})</span>
                      </h2>
                      <ul className="flex flex-col gap-1.5">
                        {s.items.slice(0, 3).map((it, i) => (
                          <li key={i}>
                            {it.href ? <a className="underline decoration-line underline-offset-4 hover:decoration-accent" href={it.href}>{it.label}</a> : it.label}
                            {it.detail && <span className="text-muted"> · {it.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
                <a href={`/orgs/${orgId}/routines/briefing`} className="mt-5 inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4">Open the full briefing</a>
              </Panel>
            )}
          </ScoutMessage>
        ) : (
          <ScoutMessage id="briefing" title="I can put a short briefing here every morning: storm leads, unanswered leads, overdue invoices and approvals. Nothing is emailed.">
            {staff && (
              <a href={`/orgs/${orgId}/routines`} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-5 font-medium hover:bg-soft">Set up the morning briefing</a>
            )}
          </ScoutMessage>
        )}

        {open.length > 0 ? (
          <ScoutMessage title={open.length === 1 ? "One thing needs your OK before it happens." : `${open.length} things need your OK before they happen.`}>
            <div className="flex flex-col gap-4">
              {open.slice(0, 5).map((item) => (
                <ApprovalCard key={item.approval.id} item={item} orgId={orgId} />
              ))}
              {open.length > 5 && (
                <a href={`/orgs/${orgId}/approvals`} className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4">See all {open.length}</a>
              )}
            </div>
          </ScoutMessage>
        ) : (
          <ScoutMessage title="Nothing needs your OK right now. When a teammate wants to send, charge or change something important, I'll ask you here first." />
        )}

        {paymentFlags.length > 0 && (
          <ScoutMessage title="Someone asked to change how a payment is made. Call the number already on file, record the call-back, then approve. Never use a number from the request.">
            <Panel>
              <ul className="flex flex-col divide-y divide-line">
                {paymentFlags.map((c) => (
                  <li key={c.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.label}</span>
                      <Badge tone="warn">{c.callbackVerifiedAt ? "call-back recorded" : "call-back needed"}</Badge>
                    </div>
                    <p className="text-muted">{c.kind}, account ending {c.accountLast4}, via {c.source}</p>
                    {!c.callbackVerifiedAt && staff && <PaymentCallbackForm orgId={orgId} changeId={c.id} onFilePhoneHint={c.onFilePhoneHint} />}
                  </li>
                ))}
              </ul>
            </Panel>
          </ScoutMessage>
        )}

        {frontDesk.length > 0 && (
          <ScoutMessage title={`${frontDesk.length === 1 ? "A booking request" : `${frontDesk.length} booking requests`} came in through your front desk. Nothing is confirmed until you OK it.`}>
            <Panel>
              <ul className="flex flex-col gap-2">
                {frontDesk.slice(0, 5).map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{b.customerName}</span>
                    {b.requesterKind === "ai_agent" && <Badge>AI assistant{b.agentName ? `: ${b.agentName}` : ""}</Badge>}
                  </li>
                ))}
              </ul>
              <a href={`/orgs/${orgId}/settings/front-desk`} className="mt-4 inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4">Open front desk</a>
            </Panel>
          </ScoutMessage>
        )}

        {flaggedDocs.length > 0 && (
          <ScoutMessage title={`I flagged ${flaggedDocs.length === 1 ? "an invoice or estimate" : `${flaggedDocs.length} invoices or estimates`} for a closer look. Nothing is paid automatically.`}>
            <Panel>
              <ul className="flex flex-col gap-2">
                {flaggedDocs.slice(0, 5).map((d) => (
                  <li key={d.id}>
                    <span className="font-medium">{d.vendorName}</span> <span className="text-muted">({d.kind}): {formatRiskFlags((d.riskFlags as string[]) ?? []) || "review"}, score {d.riskScore}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </ScoutMessage>
        )}

        {overdue.length > 0 && (
          <ScoutMessage title={`${overdue.length === 1 ? "One invoice is" : `${overdue.length} invoices are`} overdue, ${money(overdueTotal)} in total.`}>
            <a href={`/orgs/${orgId}/finance`} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-5 font-medium hover:bg-soft">Review invoices</a>
          </ScoutMessage>
        )}

        {attention.length > 0 && (
          <ScoutMessage title={`${attention.length === 1 ? "A job" : `${attention.length} jobs`} couldn't finish and need a look.`}>
            <Panel>
              <ul className="flex flex-col divide-y divide-line">
                {attention.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <a className="font-medium underline decoration-line underline-offset-4 hover:decoration-accent" href={`/orgs/${orgId}/tasks/${t.id}`}>{taskLabel(t)}</a>
                    <span className="flex items-center gap-2 text-sm text-muted">
                      <StateBadge state={t.state} />
                      <When date={t.updatedAt} />
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </ScoutMessage>
        )}

        {aiCheck && (
          <ScoutMessage
            title={`AI assistants ${aiCheck.recommended ? "do" : "don't clearly"} recommend you for ${aiCheck.trade} in ${aiCheck.zip} (score ${aiCheck.score}/100, ${aiCheck.period}).`}
          >
            {(aiCheck.suggestions as string[]).length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-muted">
                {(aiCheck.suggestions as string[]).slice(0, 3).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
          </ScoutMessage>
        )}
      </Transcript>

    </div>
  );
}
