import { listAgents, listOrgMemory } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { AGENT_ROLE_NAME } from "@/brand";
import { ActionButton, ActionForm } from "../../../actions";
import { Badge, Card, Empty, inputCls, NeedOkBadge, PageTitle, TierBadge, When } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function AgentsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager, org } = await orgContext(orgId);
  const [agents, memory] = await Promise.all([listAgents({ actorUserId: userId, orgId }), listOrgMemory({ actorUserId: userId, orgId })]);
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Each teammate can only use the tools listed. Anything that sends, pays, or changes important records waits for your OK.">
        AI workforce
      </PageTitle>
      {isManager && agents.length < 3 && (
        <ActionButton path="agent.provisionRecommended" input={{ orgId }} label="Add recommended teammates (Inbox, Pipeline, Billing)" variant="primary" />
      )}
      {agents.length === 0 && (
        <Empty action={isManager ? undefined : <span className="text-base text-muted">Ask an owner to add agents.</span>}>
          No AI teammates yet.
        </Empty>
      )}
      {agents.map((a) => {
        const maxTier = Math.max(0, ...a.permissions.map((p) => p.maxTier));
        return (
          <Card
            key={a.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {a.displayName} <Badge>{AGENT_ROLE_NAME[a.kind] ?? a.kind}</Badge>
                {a.status !== "active" && <Badge tone="danger">{a.status}</Badge>}
                <span className="text-sm text-muted">up to</span>
                <TierBadge tier={maxTier} />
                <NeedOkBadge tier={maxTier} />
              </span>
            }
          >
            <details>
              <summary className="cursor-pointer text-base text-muted hover:text-ink">
                What they can do ({a.permissions.length} tools)
              </summary>
              <ul className="mt-4 flex flex-col gap-3 text-base">
                {a.permissions.map((p) => (
                  <li key={p.tool} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-4 py-3">
                    <span className="font-mono text-sm">{p.tool}</span>
                    <TierBadge tier={p.maxTier} />
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-muted">
                Level 2 and up always waits for a person&apos;s OK. Level 4 also needs a different owner to confirm. <a className="inline-flex min-h-6 items-center underline underline-offset-4" href="/help#levels">What the levels mean</a>
              </p>
            </details>
          </Card>
        );
      })}
      <Card title="What your agents know">
        <p className="mb-4 text-base text-muted">
          Facts about your business that agents are reminded of when relevant. Agents can propose new facts, but each one needs a person&apos;s OK first.
        </p>
        {memory.length === 0 ? (
          <Empty>Nothing saved yet. Add a fact below.</Empty>
        ) : (
          <ul className="mb-5 divide-y divide-line">
            {memory.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
                <span className="min-w-0 flex-1 text-base">{m.content}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge>{m.trust === "user" ? "added by a person" : "agent-proposed, approved"}</Badge>
                  <span className="text-sm text-muted"><When date={m.createdAt} /></span>
                  {isManager && <ActionButton path="memory.forget" input={{ orgId, memoryId: m.id }} label="Forget" confirm="Remove this from what your agents know?" />}
                </span>
              </li>
            ))}
          </ul>
        )}
        {org.role !== "viewer" && (
          <ActionForm path="memory.add" fixed={{ orgId }} submitLabel="Save fact">
            <textarea name="content" required maxLength={2000} rows={2} placeholder="e.g. We invoice on the 1st; payment is due in 15 days." className={inputCls} />
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
