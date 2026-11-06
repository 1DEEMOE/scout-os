import { getOnboardingState } from "@wos/core";
import { ScoutMessage } from "./chat-ui";

/** Setup progress, as a Scout message at the top of Today until it's done. */
export async function OnboardingChecklist({ orgId, userId }: { orgId: string; userId: string }) {
  const state = await getOnboardingState({ actorUserId: userId, orgId });
  if (state.completedAt && state.checklist.every((c) => c.done)) return null;
  const done = state.checklist.filter((c) => c.done).length;
  const next = state.checklist.find((c) => !c.done);
  return (
    <ScoutMessage title={`Let's finish setting up. ${done} of ${state.checklist.length} done.`}>
      <ul className="flex flex-col gap-2">
        {state.checklist.map((c) => (
          <li key={c.id} className="flex items-center gap-3">
            <span aria-hidden className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-xs ${c.done ? "border-accent bg-accent text-on-accent" : "border-line"}`}>{c.done ? "✓" : ""}</span>
            <span className="sr-only">{c.done ? "Done: " : "To do: "}</span>
            {c.href && !c.done ? <a className="underline decoration-line underline-offset-4 hover:decoration-accent" href={c.href}>{c.label}</a> : <span className={c.done ? "text-muted line-through decoration-line" : ""}>{c.label}</span>}
          </li>
        ))}
      </ul>
      {!state.completedAt && next && (
        <a className="mt-5 inline-flex min-h-11 items-center rounded-full bg-accent px-5 font-medium text-on-accent hover:brightness-110" href={`/orgs/${orgId}/setup`}>
          Continue setup
        </a>
      )}
    </ScoutMessage>
  );
}
