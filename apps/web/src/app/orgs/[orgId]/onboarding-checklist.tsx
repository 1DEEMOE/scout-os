import { getOnboardingState } from "@wos/core";
import { SetupProgress } from "./setup-progress";

/** Setup progress for Today: a slim card until setup is finished. */
export async function OnboardingChecklist({ orgId, userId }: { orgId: string; userId: string }) {
  const state = await getOnboardingState({ actorUserId: userId, orgId });
  if (state.completedAt && state.checklist.every((c) => c.done)) return null;
  const done = state.checklist.filter((c) => c.done).length;
  const next = state.checklist.find((c) => !c.done);
  return <SetupProgress orgId={orgId} done={done} total={state.checklist.length} nextLabel={next?.label ?? null} />;
}
