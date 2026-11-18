import { ACTIVE_STATUSES, jobFormConfig, listJobs, type JobStatus, type JobView } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { AppError } from "@wos/core";
import { Badge, Card, Empty, money, PageTitle, quietButtonCls, When } from "../../../ui";
import { JobsPricingBanner } from "./pricing-banner";

export const dynamic = "force-dynamic";

const STAGE_LABEL: Record<JobStatus, string> = {
  inquiry: "New inquiry",
  estimate_ready: "Estimate ready",
  approval_pending: "Waiting on approval",
  estimate_sent: "Estimate sent",
  booked: "Booked",
  dispatched: "Dispatched",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  lost: "Lost",
};

const BOARD_ORDER: readonly JobStatus[] = ACTIVE_STATUSES;

function JobCard({ orgId, job }: { orgId: string; job: JobView }) {
  return (
    <a
      href={`/orgs/${orgId}/jobs/${job.id}`}
      className="flex flex-col gap-2 rounded-2xl border border-line bg-canvas px-4 py-3 transition-colors hover:border-accent/50"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{job.customerName}</span>
        <span className="shrink-0 text-base font-semibold">{money(job.estimate.totalCents)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-sm text-muted">
        {job.scheduledFor ? <When date={job.scheduledFor} /> : <span>Unscheduled</span>}
        {job.crew.length > 0 && <span>· crew of {job.crew.length}</span>}
        {job.estimate.priceBasis === "example" && <Badge tone="warn">example prices</Badge>}
      </span>
    </a>
  );
}

export default async function JobsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);

  let jobs: JobView[];
  let config: Awaited<ReturnType<typeof jobFormConfig>>;
  try {
    [jobs, config] = await Promise.all([listJobs({ actorUserId: userId, orgId }), jobFormConfig({ actorUserId: userId, orgId })]);
  } catch (e) {
    if (e instanceof AppError && e.code === "VALIDATION") {
      return (
        <div className="flex flex-col gap-8">
          <PageTitle sub="Intake, estimates, crew and dispatch for your industry.">Jobs</PageTitle>
          <Empty>The jobs workspace isn&apos;t available for this workspace&apos;s industry yet. Pick a supported industry under Guided setup.</Empty>
        </div>
      );
    }
    throw e;
  }

  const active = jobs.filter((j) => (ACTIVE_STATUSES as readonly string[]).includes(j.status));
  const finished = jobs.filter((j) => !(ACTIVE_STATUSES as readonly string[]).includes(j.status));

  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="From first call to done: intake, estimate, approval, crew, dispatch. Nothing is sent or dispatched without a person.">
        Jobs
      </PageTitle>
      <JobsPricingBanner orgId={orgId} isOwner={org.role === "owner"} priceBasis={config.priceBasis} fields={config.requiredBusinessFields} />
      <div className="flex flex-wrap gap-3">
        {org.role !== "viewer" && (
          <a href={`/orgs/${orgId}/jobs/new`} className={quietButtonCls}>New job</a>
        )}
        <a href={`/orgs/${orgId}/dispatch`} className={quietButtonCls}>Open the dispatch board</a>
      </div>

      {jobs.length === 0 ? (
        <Empty action={org.role !== "viewer" ? <a href={`/orgs/${orgId}/jobs/new`} className={quietButtonCls}>Take the first job</a> : undefined}>
          No jobs yet. A job starts with the intake — the same questions a good dispatcher would ask.
        </Empty>
      ) : (
        <>
          {/* Phone: one stacked list. Desktop: pipeline columns. */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {BOARD_ORDER.map((status) => {
              const inStage = active.filter((j) => j.status === status);
              if (!inStage.length) return null;
              return (
                <section key={status} aria-label={STAGE_LABEL[status]} className="flex flex-col gap-3">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-muted">
                    {STAGE_LABEL[status]}
                    <span className="rounded-full bg-line px-2 text-sm">{inStage.length}</span>
                  </h2>
                  {inStage.map((j) => <JobCard key={j.id} orgId={orgId} job={j} />)}
                </section>
              );
            })}
          </div>
          {finished.length > 0 && (
            <Card title="Finished">
              <ul className="divide-y divide-line">
                {finished.slice(0, 20).map((j) => (
                  <li key={j.id}>
                    <a href={`/orgs/${orgId}/jobs/${j.id}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2 hover:bg-line/30">
                      <span className="min-w-0 flex-1 truncate">{j.customerName}</span>
                      <span className="flex items-center gap-3 text-base text-muted">
                        <Badge tone={j.status === "done" ? "accent" : "muted"}>{STAGE_LABEL[j.status]}</Badge>
                        {money(j.estimate.totalCents)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
