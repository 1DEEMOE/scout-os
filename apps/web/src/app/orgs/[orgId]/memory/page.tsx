import { memoryPanel } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Card, Empty, PageTitle } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function MemoryPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId } = await orgContext(orgId);
  const facts = await memoryPanel({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Facts a person saved. Scout cannot change these on its own. Say “forget …” in chat to remove one.">What Scout knows</PageTitle>
      {facts.length === 0 ? <Empty>Nothing saved yet. A correction during setup shows up here with who wrote it.</Empty> : (
        <ul className="flex flex-col gap-4">
          {facts.map((fact) => (
            <li key={fact.id}>
              <Card>
                <p className="text-lg">{fact.text}</p>
                <p className="mt-2 text-base text-muted">Remembered by {fact.by} · {fact.trust} · {new Date(fact.at).toLocaleString("en-US", { month: "short", day: "numeric" })}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
