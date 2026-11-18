import { jobFormConfig } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { AppError } from "@wos/core";
import { Empty, PageTitle } from "../../../../ui";
import { NewJobForm } from "./new-job-form";

export const dynamic = "force-dynamic";

export default async function NewJobPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  if (org.role === "viewer") {
    return (
      <div className="flex flex-col gap-8">
        <PageTitle>New job</PageTitle>
        <Empty>Viewers can see jobs but can&apos;t create them. Ask a manager.</Empty>
      </div>
    );
  }

  let config: Awaited<ReturnType<typeof jobFormConfig>>;
  try {
    config = await jobFormConfig({ actorUserId: userId, orgId });
  } catch (e) {
    if (e instanceof AppError && e.code === "VALIDATION") {
      return (
        <div className="flex flex-col gap-8">
          <PageTitle>New job</PageTitle>
          <Empty>The jobs workspace isn&apos;t available for this workspace&apos;s industry yet.</Empty>
        </div>
      );
    }
    throw e;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="The questions below come from your industry pack — what a good dispatcher asks on the first call. Nothing is sent to the customer from this form.">
        New job
      </PageTitle>
      <NewJobForm orgId={orgId} intake={config.intake} />
    </div>
  );
}
