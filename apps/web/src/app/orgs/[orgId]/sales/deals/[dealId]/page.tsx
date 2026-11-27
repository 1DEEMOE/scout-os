import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getDeal, listMembers } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Badge, Card, money, PageTitle, stageLabel, When } from "../../../../../ui";
import { DealActions } from "./deal-actions";

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-base sm:text-right">{children}</span>
    </div>
  );
}

export default async function DealPage({ params }: { params: Promise<{ orgId: string; dealId: string }> }) {
  const { orgId, dealId } = await params;
  const { userId, org } = await orgContext(orgId);
  const deal = await getDeal({ actorUserId: userId, orgId, dealId }).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const members = await listMembers({ actorUserId: userId, orgId });
  const ownerName = deal.ownerUserId ? (members.find((m) => m.userId === deal.ownerUserId)?.name ?? deal.ownerUserId) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageTitle
        sub={
          <>
            <Link href={`/orgs/${orgId}/sales`} className="text-accent underline">
              Sales
            </Link>{" "}
            · opened <When date={deal.createdAt} />
          </>
        }
      >
        {deal.name}
      </PageTitle>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2">Deal <Badge tone={deal.stage === "won" ? "accent" : deal.stage === "lost" ? "muted" : "warn"}>{stageLabel(deal.stage)}</Badge></span>}>
          <div className="divide-y divide-line">
            <Row label="Amount">{money(deal.amountCents)}</Row>
            <Row label="Win probability">{Math.round(deal.probabilityBps / 100)}%</Row>
            <Row label="Weighted value">{money(deal.weightedCents)}</Row>
            <Row label="Contact">
              {deal.contactId ? (
                <Link className="text-accent underline" href={`/orgs/${orgId}/sales/contacts/${deal.contactId}`}>
                  {deal.contactName || deal.contactEmail || "View contact"}
                </Link>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Expected close">{deal.expectedClose ?? "—"}</Row>
            <Row label="Owner">{ownerName ?? "—"}</Row>
            <Row label="Source">{deal.source === "web_form" ? "Web lead form" : deal.source}</Row>
            {deal.closedAt && (
              <Row label={deal.stage === "won" ? "Won" : "Lost"}>
                <When date={deal.closedAt} />
              </Row>
            )}
            {deal.lostReason && <Row label="Lost reason">{deal.lostReason}</Row>}
          </div>
        </Card>

        <DealActions
          orgId={orgId}
          role={org.role}
          deal={{
            id: deal.id,
            name: deal.name,
            stage: deal.stage,
            amountCents: deal.amountCents,
            expectedClose: deal.expectedClose,
            ownerUserId: deal.ownerUserId,
            lostReason: deal.lostReason,
          }}
          members={members.map((m) => ({ userId: m.userId, name: m.name }))}
        />
      </div>
    </div>
  );
}
