import { getOnboardingState } from "@wos/core";

export async function OnboardingChecklist({ orgId, userId }: { orgId: string; userId: string }) {
  const state = await getOnboardingState({ actorUserId: userId, orgId });
  if (state.completedAt && state.checklist.every((c) => c.done)) return null;
  const done = state.checklist.filter((c) => c.done).length;
  const next = state.checklist.find((c) => !c.done);
  return (
    <section className="rounded-[var(--radius-card)] border border-accent/40 bg-accent/5 p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Finish setup</h2>
        <span className="text-base text-muted">{done}/{state.checklist.length} done</span>
      </div>
      <ul className="flex flex-col gap-2 text-base">
        {state.checklist.map((c) => (
          <li key={c.id} className="flex items-center gap-3">
            <span aria-hidden className="text-lg">{c.done ? "✓" : "○"}</span>
            {c.href && !c.done ? <a className="underline" href={c.href}>{c.label}</a> : <span className={c.done ? "text-muted" : ""}>{c.label}</span>}
          </li>
        ))}
      </ul>
      {!state.completedAt && next && (
        <p className="mt-5">
          <a className="inline-flex rounded-lg bg-accent px-5 py-2.5 text-base font-medium text-on-accent" href={`/orgs/${orgId}/setup`}>
            Continue setup
          </a>
        </p>
      )}
    </section>
  );
}
