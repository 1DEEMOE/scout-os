import {
  approvalsForReview,
  deliverNotifications,
  findOverdue,
  formatRiskFlags,
  latestAiAnswersCheck,
  latestBriefing,
  listFlaggedDocuments,
  listFlaggedPaymentChanges,
  listPendingFrontDeskBookings,
  readPilotMetrics,
  speedSummary,
  listOpportunities,
  listTasks,
  planSummary,
  taskLabel,
  type Briefing,
} from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../actions";
import { Badge, money, StateBadge, When } from "../../ui";
import { ApprovalCard, Panel, ScoutMessage, Transcript } from "./chat-ui";
import { Composer } from "./composer";
import { OnboardingChecklist } from "./onboarding-checklist";
import { PaymentCallbackForm } from "./payment-callback-form";

export const dynamic = "force-dynamic";

const SUGGESTIONS = ["Chase overdue invoices", "Follow up with new leads", "What needs my attention today?"];
/** Approvals shown in full before "show more": enough to act on, not a wall. */
const APPROVALS_UP_FRONT = 2;

const link = "inline-flex min-h-11 items-center font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent";
const inlineLink = "inline-flex min-h-6 items-center underline decoration-line underline-offset-4 hover:decoration-accent";

/** A collapsed update inside "Also today": one calm line, details on demand. */
function Update({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <li>
      <details className="group rounded-2xl border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 [&::-webkit-details-marker]:hidden">
          <span>{summary}</span>
          <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 8 5 5 5-5" />
          </svg>
        </summary>
        <div className="border-t border-line px-5 py-4">{children}</div>
      </details>
    </li>
  );
}

/**
 * Today: a conversation with Scout, in priority order. The morning briefing
 * leads; then what needs a decision; then safety warnings; everything else is
 * one calm "Also today" message with collapsed rows.
 */
/** Sample opportunities shown right after setup: invented (DEMO) rows only, top three. */
async function sampleOpportunities(who: { actorUserId: string; orgId: string }, staff: boolean) {
  if (!staff) return [];
  const plan = await planSummary(who);
  if (!plan.plan.features.includes("scout")) return [];
  const rows = await listOpportunities({ ...who, limit: 3 });
  return rows.filter((o) => o.demo || o.prospect.demo);
}

export default async function TodayPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ welcome?: string }> }) {
  const { orgId } = await params;
  const justSetUp = (await searchParams).welcome === "1";
  const { userId, org } = await orgContext(orgId);
  const staff = org.role !== "viewer";
  const who = { actorUserId: userId, orgId };
  const [review, tasks, overdue, latest, paymentFlags, frontDesk, flaggedDocs, aiCheck, samples, pace, pilot] = await Promise.all([
    approvalsForReview(who),
    listTasks({ ...who, limit: 100 }),
    findOverdue(who),
    latestBriefing(who),
    listFlaggedPaymentChanges(who),
    listPendingFrontDeskBookings(who),
    listFlaggedDocuments(who),
    latestAiAnswersCheck(who),
    justSetUp ? sampleOpportunities(who, staff) : Promise.resolve([]),
    speedSummary(who).catch(() => ({ leads: 0, within60: 0, label: "respond-in-60s" as const })),
    readPilotMetrics(who).catch(() => null),
  ]);
  const open = review.open;
  const delivery = await deliverNotifications({
    actorUserId: userId,
    orgId,
    items: open.map((item) => ({ id: item.approval.id, tier: item.approval.tier, item })),
  });
  const nowApprovals = delivery.now.map((row) => row.item);
  const briefApprovals = delivery.brief.map((row) => row.item);
  const briefing = latest?.run.output as Briefing | undefined;
  const sections = briefing?.sections.filter((s) => s.status === "ok" && s.count > 0).slice(0, 4) ?? [];
  const attention = tasks.filter((t) => t.state === "ESCALATED" || t.state === "FAILED").slice(0, 5);
  const overdueTotal = overdue.reduce((s, i) => s + i.amountDueCents, 0);
  // The briefing knows the business's time zone; fall back to the server's.
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: briefing?.timezone });
  const alsoToday = (frontDesk.length > 0 ? 1 : 0) + (flaggedDocs.length > 0 ? 1 : 0) + (overdue.length > 0 ? 1 : 0) + (attention.length > 0 ? 1 : 0) + (aiCheck ? 1 : 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      <header className="mb-10">
        <p className="text-muted">{today}</p>
        <h1 className="mt-1 text-display font-semibold">Today</h1>
        <p className="mt-2 text-lg text-muted">Here&apos;s what Scout has for {org.name}.</p>
      </header>

      {staff && <OnboardingChecklist orgId={orgId} userId={userId} />}

      {staff ? (
        <div className="mb-14">
          <Composer orgId={orgId} suggestions={SUGGESTIONS} />
        </div>
      ) : (
        <p className="mb-12 text-muted">You have view-only access, so you can read but not ask Scout to act.</p>
      )}

      <Transcript label="Today with Scout">
        {briefing ? (
          <ScoutMessage id="briefing" at={briefing.generatedAt} title={sections.length ? "Good morning. Here's your briefing." : "Good morning. Your briefing is in, and everything's clear."}>
            {sections.length > 0 && (
              <Panel>
                <div className="flex flex-col gap-7">
                  {sections.map((s) => (
                    <section key={s.key}>
                      <h2 className="mb-2.5 font-semibold">
                        {s.title} <span className="font-normal text-muted">({s.count})</span>
                      </h2>
                      <ul className="flex flex-col gap-2">
                        {s.items.slice(0, 3).map((it, i) => (
                          <li key={i} className="leading-relaxed">
                            {it.href ? <a className={inlineLink} href={it.href}>{it.label}</a> : it.label}
                            {it.detail && <span className="text-muted"> · {it.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
                <a href={`/orgs/${orgId}/routines/briefing`} className={`mt-6 ${link}`}>Open the full briefing</a>
              </Panel>
            )}
          </ScoutMessage>
        ) : (
          <ScoutMessage id="briefing" title="Each morning I can put a short briefing here: storm leads, unanswered leads, overdue invoices and approvals. Nothing is emailed.">
            {staff && (
              <a href={`/orgs/${orgId}/routines`} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-5 font-medium transition-colors duration-150 hover:bg-soft">Set up the morning briefing</a>
            )}
          </ScoutMessage>
        )}

        {pilot && (
          <ScoutMessage id="pilot" title="Pilot numbers">
            <ul className="flex flex-col gap-2 text-lg leading-relaxed">
              <li>Setup time: {pilot.setupSeconds == null ? "not finished yet" : `${Math.max(1, Math.round(pilot.setupSeconds / 60))} min`}. The welcome steps are budgeted under 10 minutes.</li>
              <li>First reply approved: {pilot.firstReplySeconds == null ? "not yet" : `${Math.max(1, Math.round(pilot.firstReplySeconds / 60))} min after setup started`}. Approving a template is the human OK. It does not send by itself.</li>
              <li>Bookings recovered: {pilot.bookingsRecovered}. Counted when a missed or late-cancelled visit is booked again.</li>
              <li>Hours saved: about {pilot.hoursSavedMinutes} minutes. That is an estimate of 6 minutes for each morning briefing that ran ({pilot.briefingRuns}), not a timesheet.</li>
            </ul>
          </ScoutMessage>
        )}

        <ScoutMessage id="pace" title="Respond in 60 seconds">
          <p className="text-lg leading-relaxed">
            {pace.leads === 0
              ? "No new leads timed yet. When one arrives, the first reply is measured from that moment."
              : `${pace.within60} of ${pace.leads} first replies went out within a minute.`}
          </p>
          <p className="mt-3 text-small text-muted">Texts need a recorded yes, honor STOP, and stay between 8am and 9pm in the recipient&apos;s time zone. A pre-approved template is the human OK. Anything else waits in Approvals. Nothing is paid automatically.</p>
        </ScoutMessage>

        {justSetUp && (
          <ScoutMessage id="first-win" title={samples.length ? `You're set up. Here ${samples.length === 1 ? "is a sample opportunity" : `are ${samples.length} sample opportunities`} to try first.` : "You're set up. Your briefing will be here every morning."}>
            {samples.length > 0 && (
              <Panel>
                <ul aria-label="Sample opportunities" className="flex flex-col gap-3">
                  {samples.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center justify-between gap-3">
                      <a className={`${inlineLink} font-medium`} href={`/orgs/${orgId}/scout/opportunities/${o.id}`}>{o.prospect.name}</a>
                      <span className="text-small text-muted">{o.prospect.city ? `${o.prospect.city} · ` : ""}score {o.score}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-small text-muted">These are invented DEMO records so you can see how Scout works.</p>
                <div className="mt-3">
                  <ActionButton path="onboarding.clearDemo" input={{ orgId }} label="Remove sample data" confirm="Remove every DEMO sample record?" />
                </div>
              </Panel>
            )}
          </ScoutMessage>
        )}

        {nowApprovals.length > 0 ? (
          <ScoutMessage title={nowApprovals.length === 1 ? "One thing needs your OK before it happens." : `${nowApprovals.length} things need your OK before they happen.`}>
            <div className="flex flex-col gap-5">
              {nowApprovals.slice(0, APPROVALS_UP_FRONT).map((item) => (
                <ApprovalCard key={item.approval.id} item={item} orgId={orgId} />
              ))}
              {nowApprovals.length > APPROVALS_UP_FRONT && (
                <details className="group">
                  <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-surface px-5 font-medium transition-colors duration-150 hover:bg-soft [&::-webkit-details-marker]:hidden">
                    <span className="group-open:hidden">Show {nowApprovals.length - APPROVALS_UP_FRONT} more</span>
                    <span className="hidden group-open:inline">Show fewer</span>
                  </summary>
                  <div className="mt-5 flex flex-col gap-5">
                    {nowApprovals.slice(APPROVALS_UP_FRONT).map((item) => (
                      <ApprovalCard key={item.approval.id} item={item} orgId={orgId} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          </ScoutMessage>
        ) : (
          <ScoutMessage title="Nothing needs your OK right now. When a teammate wants to send, charge or change something important, I'll ask you here first." />
        )}
        {briefApprovals.length > 0 && (
          <ScoutMessage title={delivery.quiet ? "Held for the morning brief. Quiet hours are on, so these wait." : "Held for the morning brief. Today's alert cap is full."}>
            <div className="flex flex-col gap-5">
              {briefApprovals.map((item) => (
                <ApprovalCard key={item.approval.id} item={item} orgId={orgId} />
              ))}
            </div>
          </ScoutMessage>
        )}

        {paymentFlags.length > 0 && (
          <ScoutMessage title="Someone asked to change how a payment is made. Call the number already on file, record the call-back, then approve. Never use a number from the request.">
            <Panel>
              <ul className="flex flex-col divide-y divide-line">
                {paymentFlags.map((c) => (
                  <li key={c.id} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0">
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

        {alsoToday > 0 && (
          <ScoutMessage title="Also today, when you have a minute:">
            <ul aria-label="Also today" className="flex flex-col gap-3">
              {frontDesk.length > 0 && (
                <Update summary={`${frontDesk.length === 1 ? "A booking request" : `${frontDesk.length} booking requests`} at your front desk`}>
                  <ul className="flex flex-col gap-2">
                    {frontDesk.slice(0, 5).map((b) => (
                      <li key={b.id} className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{b.customerName}</span>
                        {b.requesterKind === "ai_agent" && <Badge>AI assistant{b.agentName ? `: ${b.agentName}` : ""}</Badge>}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-muted">Nothing is confirmed until you OK it.</p>
                  <a href={`/orgs/${orgId}/settings/front-desk`} className={`mt-2 ${link}`}>Open front desk</a>
                </Update>
              )}
              {overdue.length > 0 && (
                <Update summary={`${overdue.length === 1 ? "One invoice is" : `${overdue.length} invoices are`} overdue (${money(overdueTotal)})`}>
                  <a href={`/orgs/${orgId}/finance`} className={link}>Review invoices</a>
                </Update>
              )}
              {flaggedDocs.length > 0 && (
                <Update summary={`${flaggedDocs.length === 1 ? "An invoice or estimate" : `${flaggedDocs.length} invoices or estimates`} flagged for a closer look`}>
                  <ul className="flex flex-col gap-2">
                    {flaggedDocs.slice(0, 5).map((d) => (
                      <li key={d.id}>
                        <span className="font-medium">{d.vendorName}</span> <span className="text-muted">({d.kind}): {formatRiskFlags((d.riskFlags as string[]) ?? []) || "review"}, score {d.riskScore}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-muted">Nothing is paid automatically.</p>
                </Update>
              )}
              {attention.length > 0 && (
                <Update summary={`${attention.length === 1 ? "A job" : `${attention.length} jobs`} couldn't finish`}>
                  <ul className="flex flex-col gap-3">
                    {attention.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-3">
                        <a className={`${inlineLink} font-medium`} href={`/orgs/${orgId}/tasks/${t.id}`}>{taskLabel(t)}</a>
                        <span className="flex items-center gap-2 text-sm text-muted">
                          <StateBadge state={t.state} />
                          <When date={t.updatedAt} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </Update>
              )}
              {aiCheck && (
                <Update summary={`AI assistants ${aiCheck.recommended ? "recommend you" : "don't clearly recommend you yet"} (${aiCheck.score}/100)`}>
                  <p className="text-muted">{aiCheck.trade} in {aiCheck.zip}, {aiCheck.period}.</p>
                  {(aiCheck.suggestions as string[]).length > 0 && (
                    <ul className="mt-3 list-disc space-y-1.5 pl-5">
                      {(aiCheck.suggestions as string[]).slice(0, 3).map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  )}
                </Update>
              )}
            </ul>
          </ScoutMessage>
        )}
      </Transcript>
    </div>
  );
}
