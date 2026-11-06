import { notFound } from "next/navigation";
import { AppError, draftFirstOutreach, getOpportunity, listMembers, planSummary } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton, ActionForm } from "../../../../../actions";
import { Badge, Card, inputCls, PageTitle, StateBadge, When } from "../../../../../ui";
import { actorName, DemoBadge, ScoreTable, ScoutTabs, StageBadge, UpgradeNotice, Utc } from "../../parts";
import { QualifyForm } from "../../forms";
import { OutreachCard } from "./outreach-card";

export const dynamic = "force-dynamic";

type Explanation = {
  whyIdentified: string;
  whyRelevant: string;
  evidence: { signalId: string; description: string; place: string; distanceMiles: number | null; eventAt: string; source: string; confidence: string; demo?: boolean }[];
  missingInformation: string[];
  recommendedAction: string;
  confidenceBasis: string;
};

const BASIS_LABEL: Record<string, string> = { existing_customer: "existing customer", inbound_inquiry: "they contacted you", express_written_consent: "written consent" };

export default async function OpportunityPage({ params }: { params: Promise<{ orgId: string; opportunityId: string }> }) {
  const { orgId, opportunityId } = await params;
  const { userId, isManager, org } = await orgContext(orgId);
  const plan = await planSummary({ actorUserId: userId, orgId });
  if (!plan.plan.features.includes("scout")) return <UpgradeNotice orgId={orgId} planLabel={plan.plan.label} />;
  const d = await getOpportunity({ actorUserId: userId, orgId, opportunityId }).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const { opportunity: o, prospect: p } = d;
  const names = new Map((await listMembers({ actorUserId: userId, orgId })).map((m) => [m.userId, m.name]));
  const e = o.explanation as unknown as Explanation;
  const open = o.stage !== "disqualified";
  const draft = open ? await draftFirstOutreach({ actorUserId: userId, orgId, opportunityId }).catch(() => null) : null;
  const handoffRunning = d.handoff && !["COMPLETED", "FAILED"].includes(d.handoff.state);

  return (
    <div>
      <PageTitle sub={<a className="underline" href={`/orgs/${orgId}/scout`}>Back to opportunities</a>}>
        <span className="flex flex-wrap items-center gap-2">{p.name} <StageBadge stage={o.stage} /> {o.demo && <DemoBadge />}</span>
      </PageTitle>
      <ScoutTabs orgId={orgId} active="feed" role={org.role} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          {draft && org.role !== "viewer" && (
            <OutreachCard orgId={orgId} opportunityId={o.id} to={draft.to} subject={draft.subject} body={draft.body} canRequest={draft.canRequest} blockedReason={draft.blockedReason} canAsk={isManager} />
          )}
          <Card title="Why Scout picked this">
            <dl className="flex flex-col gap-3 text-sm">
              <div><dt className="text-muted">Why identified</dt><dd>{e.whyIdentified}</dd></div>
              <div><dt className="text-muted">Why it may be relevant</dt><dd>{e.whyRelevant}</dd></div>
              <div><dt className="text-muted">What&apos;s missing</dt><dd><ul className="list-disc pl-5">{e.missingInformation.map((m) => <li key={m}>{m}</li>)}</ul></dd></div>
              <div><dt className="text-muted">Recommended next step</dt><dd className="font-medium">{e.recommendedAction}</dd></div>
              <div><dt className="text-muted">How sure</dt><dd>{e.confidenceBasis}</dd></div>
            </dl>
          </Card>
          <Card title="Score"><ScoreTable score={o.score} breakdown={o.scoreBreakdown} /></Card>
          <Card title={`Evidence (${e.evidence.length})`}>
            <ul className="divide-y divide-line text-sm">
              {e.evidence.map((ev) => (
                <li key={ev.signalId} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ev.description}</span>
                    <span className="text-muted">{ev.distanceMiles === null ? "same county" : `${ev.distanceMiles} mi away`}</span>
                    {ev.demo && <DemoBadge />}
                  </div>
                  <div className="text-xs text-muted">{ev.place} · <Utc date={ev.eventAt} /></div>
                  <div className="text-xs text-muted">Source: {ev.source}, preliminary and not quality-controlled.</div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="History">
            <ol className="flex flex-col gap-2 text-sm">
              {d.events.map((ev) => (
                <li key={ev.id} className="border-l-2 border-line pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {ev.fromStage ? <><StageBadge stage={ev.fromStage} /> → </> : null}<StageBadge stage={ev.toStage} />
                    <span className="text-xs text-muted"><When date={ev.createdAt} /> · {actorName(names, ev.actorType, ev.actorId)}</span>
                  </div>
                  <p className="text-muted">{ev.evidence}</p>
                </li>
              ))}
            </ol>
            {d.outreach.length > 0 && (
              <>
                <h3 className="mt-4 mb-2 text-sm font-medium">Emails</h3>
                <ul className="text-sm">
                  {d.outreach.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-2 py-1">
                      <Badge tone={x.kind === "sent" ? "accent" : "danger"}>{x.kind}</Badge> {x.recipient}
                      {x.reason && <span className="text-muted">({x.reason === "suppressed" ? "do-not-contact" : "no permission"})</span>}
                      <span className="text-xs text-muted"><When date={x.createdAt} /></span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Contact">
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
              <dt className="text-muted">Email</dt><dd className="break-all">{p.email ?? "—"}</dd>
              <dt className="text-muted">Phone</dt><dd>{p.phone ?? "—"}</dd>
              <dt className="text-muted">Address</dt><dd>{[p.address, p.city, p.state, p.postalCode].filter(Boolean).join(", ") || "—"}</dd>
              <dt className="text-muted">May email?</dt>
              <dd>
                {d.suppressed ? <Badge tone="danger">do-not-contact</Badge>
                  : d.permission ? <Badge tone="accent">yes · {BASIS_LABEL[d.permission.basis]}</Badge>
                  : <Badge>not recorded</Badge>}
              </dd>
            </dl>
            {!d.suppressed && p.email && (
              <div className="mt-3">
                <ActionButton path="scout.suppress" input={{ orgId, email: p.email, reason: "opt_out" }} label="Add to do-not-contact" variant="danger" confirm={`Never email ${p.email} from Scout OS?`} />
              </div>
            )}
          </Card>
          {open && o.stage === "prospect" && (
            <Card title="They got in touch?">
              <ActionForm path="scout.engage" fixed={{ orgId, opportunityId: o.id }} submitLabel="Mark engaged">
                <label className="flex flex-col gap-1 text-sm">What happened
                  <textarea name="evidence" required minLength={5} rows={2} placeholder="Called the office on Tuesday asking for an inspection." className={inputCls} />
                </label>
              </ActionForm>
              <p className="mt-2 text-xs text-muted">An email from them is picked up automatically when the inbox syncs.</p>
            </Card>
          )}
          {o.stage === "engaged" && (
            <Card title="Qualify"><QualifyForm orgId={orgId} opportunityId={o.id} questions={d.qualificationQuestions} /></Card>
          )}
          {o.stage === "qualified" && (
            <Card title="Hand to Pipeline">
              {handoffRunning ? (
                <p className="text-sm">Handoff in progress: <a className="underline" href={`/orgs/${orgId}/tasks/${d.handoff!.id}`}>task</a> <StateBadge state={d.handoff!.state} /></p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-muted">Pipeline saves the contact, opens a deal and adds a note. Each CRM write waits for approval.</p>
                  <ActionButton path="scout.handoff" input={{ orgId, opportunityId: o.id }} label="Hand to Pipeline" variant="primary" redirectToTask={{ orgId }} />
                </>
              )}
            </Card>
          )}
          {open && (
            <Card title="Rule out">
              <ActionForm path="scout.disqualify" fixed={{ orgId, opportunityId: o.id }} submitLabel="Rule out" quiet>
                <label className="flex flex-col gap-1 text-sm">Reason
                  <input name="reason" required minLength={3} maxLength={500} placeholder="Renter, not the owner" className={inputCls} />
                </label>
              </ActionForm>
            </Card>
          )}
          {!isManager && <p className="text-xs text-muted">Recording contact permissions is for managers.</p>}
        </div>
      </div>
    </div>
  );
}
