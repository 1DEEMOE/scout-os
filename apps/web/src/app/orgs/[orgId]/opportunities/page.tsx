import { opportunitiesFor, readPackId } from "@wos/core";
import { withTenant } from "@wos/db";
import { orgContext } from "@/server/org-context";
import { notFound } from "next/navigation";
import { Badge, Card, MockBadge, PageTitle } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  if (org.role === "viewer") notFound();
  const packId = await withTenant(orgId, (tx) => readPackId(tx)) ?? "general";
  const cards = await opportunitiesFor({ actorUserId: userId, orgId, packId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Read-only ideas. Each one is a draft. Nothing is sent, posted, or paid.">Opportunities</PageTitle>
      <ul className="flex flex-col gap-5">
        {cards.map((card) => (
          <li key={card.id}>
            <Card>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{card.lane}</Badge>
                  {card.demo && <MockBadge />}
                </div>
                <h2 className="text-xl font-semibold">{card.title}</h2>
                <p className="text-lg">{card.draft}</p>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
