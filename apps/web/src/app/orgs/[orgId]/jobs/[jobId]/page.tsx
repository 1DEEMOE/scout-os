import { disclosuresFor, getElitePack, getJob, jobFormConfig, listMembers } from "@wos/core";
import { notFound } from "next/navigation";
import { orgContext } from "@/server/org-context";
import { AppError } from "@wos/core";
import { Badge, Card, money, PageTitle, When } from "../../../../ui";
import { JobActions } from "./job-actions";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ orgId: string; jobId: string }> }) {
  const { orgId, jobId } = await params;
  const { userId, org, isManager } = await orgContext(orgId);

  let job: Awaited<ReturnType<typeof getJob>>;
  let config: Awaited<ReturnType<typeof jobFormConfig>>;
  try {
    [job, config] = await Promise.all([
      getJob({ actorUserId: userId, orgId, jobId }),
      jobFormConfig({ actorUserId: userId, orgId }),
    ]);
  } catch (e) {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  }

  const pack = getElitePack(job.packId);
  const disclosures = pack ? disclosuresFor(pack, "estimate", job.jurisdiction) : [];
  const members = isManager ? await listMembers({ actorUserId: userId, orgId }) : [];
  const crewMembers = members.filter((m) => job.crew.includes(m.userId));
  const labels = new Map(config.intake.map((f) => [f.id, f.label]));

  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub={`${job.customerName} · created `}>
        Job
      </PageTitle>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Customer & intake">
          <dl className="flex flex-col gap-3 text-base">
            <div className="flex justify-between gap-4"><dt className="text-muted">Name</dt><dd className="text-right">{job.customerName}</dd></div>
            {job.customerEmail && <div className="flex justify-between gap-4"><dt className="text-muted">Email</dt><dd className="text-right break-all">{job.customerEmail}</dd></div>}
            {job.customerPhone && <div className="flex justify-between gap-4"><dt className="text-muted">Phone</dt><dd className="text-right">{job.customerPhone}</dd></div>}
            <div className="my-1 border-t border-line" />
            {Object.entries(job.answers).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-muted">{labels.get(k) ?? k}</dt>
                <dd className="text-right">{v === true ? "Yes" : v === false ? "No" : String(v)}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card
          title="Estimate"
          actions={<Badge tone={job.estimate.priceBasis === "example" ? "warn" : "accent"}>{job.estimate.priceBasis === "example" ? "example prices" : "your prices"}</Badge>}
        >
          {job.estimate.lines.length === 0 ? (
            <p className="text-base text-muted">No estimate lines yet — run “Prepare estimate” below.</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2 text-base">
                {job.estimate.lines.map((l) => (
                  <li key={l.id} className="flex items-baseline justify-between gap-4">
                    <span>{l.label} <span className="text-sm text-muted">({l.detail})</span></span>
                    <span className="shrink-0 font-medium">{money(l.cents)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-base">
                <div className="flex justify-between"><span className="text-muted">Subtotal</span><span>{money(job.estimate.subtotalCents)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Tax</span><span>{money(job.estimate.taxCents)}</span></div>
                <div className="flex justify-between text-lg font-semibold"><span>Total</span><span>{money(job.estimate.totalCents)}</span></div>
                {job.estimate.depositCents > 0 && (
                  <div className="flex justify-between"><span className="text-muted">Deposit (request only)</span><span>{money(job.estimate.depositCents)}</span></div>
                )}
              </div>
            </>
          )}
          {job.estimate.warnings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-warn">
              {job.estimate.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {job.estimate.blockedReasons.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-danger">
              {job.estimate.blockedReasons.map((b) => <li key={b}>Blocked: {b}</li>)}
            </ul>
          )}
        </Card>
      </div>

      {disclosures.length > 0 && (
        <Card title="Required notices on the estimate">
          <ul className="flex flex-col gap-2 text-base text-muted">
            {disclosures.map((d) => <li key={d.id}>{d.text}</li>)}
          </ul>
        </Card>
      )}

      <Card title="Crew & schedule">
        <div className="flex flex-col gap-2 text-base">
          <p>
            {job.scheduledFor ? <>Scheduled for <When date={job.scheduledFor} /></> : "Not scheduled yet."}
          </p>
          <p>
            {crewMembers.length
              ? `Crew: ${crewMembers.map((m) => m.name).join(", ")}`
              : job.crew.length
                ? `Crew: ${job.crew.length} assigned`
                : "No crew assigned yet."}
          </p>
          {job.sentAt && <p className="text-muted">Estimate sent <When date={job.sentAt} />.</p>}
        </div>
      </Card>

      <JobActions
        orgId={orgId}
        jobId={job.id}
        status={job.status}
        role={org.role}
        blocked={job.estimate.blockedReasons.length > 0}
        hasEmail={Boolean(job.customerEmail)}
        crew={job.crew}
        scheduledFor={job.scheduledFor}
        members={members.map((m) => ({ id: m.userId, name: m.name }))}
      />
    </div>
  );
}
