import { getOnboardingState } from "@wos/core";
import { redirect } from "next/navigation";
import { orgContext } from "@/server/org-context";
import { PageTitle } from "../../../ui";
import { SetupWizard } from "./wizard";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { userId, isManager } = await orgContext(orgId);
  const state = await getOnboardingState({ actorUserId: userId, orgId });
  if (state.completedAt && sp.step !== "checklist") {
    // Already done — send them to the briefing unless they explicitly reopen.
    redirect(`/orgs/${orgId}/routines/briefing`);
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageTitle sub="About five minutes. Approvals, consent and pause-all stay exactly as they are — this just gets you to a useful Morning Briefing faster.">
        Set up Scout OS
      </PageTitle>
      {!isManager ? (
        <p className="text-sm text-muted">Ask an owner or admin to finish setup. You can still browse the checklist on the overview.</p>
      ) : (
        <SetupWizard orgId={orgId} initial={state} />
      )}
    </div>
  );
}
