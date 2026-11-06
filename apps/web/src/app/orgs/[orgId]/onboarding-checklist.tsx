import { getOnboardingState } from "@wos/core";
import { quickstartProgress } from "./welcome/progress";
import { SetupProgress } from "./setup-progress";

/** Setup progress for Today: a slim card until the three quick steps are done. */
export async function OnboardingChecklist({ orgId, userId }: { orgId: string; userId: string }) {
  const state = await getOnboardingState({ actorUserId: userId, orgId });
  if (state.completedAt) return null;
  const p = quickstartProgress(state.step);
  return <SetupProgress orgId={orgId} done={p.done} total={3} nextLabel={p.nextLabel} minutesLeft={p.minutesLeft} />;
}
