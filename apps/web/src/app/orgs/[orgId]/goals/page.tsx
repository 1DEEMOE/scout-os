import { listGoals } from "@wos/core";
import { ActionForm } from "../../../actions";
import { orgContext } from "@/server/org-context";
import { Card, Empty, inputCls, PageTitle } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function GoalsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager } = await orgContext(orgId);
  const goals = await listGoals({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="One outcome for this week. A goal never spends money or messages a customer on its own.">This week</PageTitle>
      <Card title="Weekly card">
        {goals.length === 0 ? <Empty>No goal yet. Write one sentence for the week.</Empty> : (
          <ul className="flex flex-col gap-4">
            {goals.map((goal) => (
              <li key={goal.id} className="rounded-2xl border border-line px-5 py-4">
                <p className="text-lg">{goal.text}</p>
                <p className="mt-2 text-base text-muted">{goal.progress}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {isManager && (
        <Card title="Add a goal">
          <ActionForm path="kimi.goal" fixed={{ orgId }} submitLabel="Save goal">
            <label htmlFor="goal-text" className="text-base">What should be true by Friday?</label>
            <input id="goal-text" name="text" required maxLength={200} placeholder="Fill Thursday afternoon" className={inputCls} />
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
