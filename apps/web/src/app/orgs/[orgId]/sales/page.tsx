import { listContacts, listDeals } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Badge, Card, Empty, money, PageTitle, stageLabel } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function SalesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId } = await orgContext(orgId);
  const [contacts, deals] = await Promise.all([listContacts({ actorUserId: userId, orgId }), listDeals({ actorUserId: userId, orgId })]);
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Customers and deals. Stage changes and amounts need your OK.">Customers &amp; Deals</PageTitle>
      <Card title="Deals">
        {deals.length === 0 ? (
          <Empty action={<a className="font-medium text-accent underline" href={`/orgs/${orgId}/inbox`}>Open Inbox</a>}>
            No deals yet. Open an email and choose &quot;Treat as sales lead&quot;.
          </Empty>
        ) : (
          <>
            <ul className="divide-y divide-line sm:hidden">
              {deals.map(({ deal, contactEmail, contactName }) => (
                <li key={deal.id} className="flex flex-col gap-2 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-medium">{deal.name}</div>
                      <div className="text-base text-muted">{contactName || contactEmail}</div>
                    </div>
                    <div className="text-lg font-semibold tabular-nums">{money(deal.amountCents)}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge>{stageLabel(deal.stage)}</Badge>
                    {deal.provider === "fake" && <Badge tone="warn">MOCK</Badge>}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-base">
                <thead className="text-muted">
                  <tr className="border-b border-line">
                    <th className="py-3 pr-4 font-normal">Deal</th>
                    <th className="py-3 pr-4 font-normal">Contact</th>
                    <th className="py-3 pr-4 font-normal">Stage</th>
                    <th className="py-3 text-right font-normal">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map(({ deal, contactEmail, contactName }) => (
                    <tr key={deal.id} className="border-b border-line">
                      <td className="py-4 pr-4">{deal.name} {deal.provider === "fake" && <Badge tone="warn">MOCK</Badge>}</td>
                      <td className="py-4 pr-4">{contactName || contactEmail}</td>
                      <td className="py-4 pr-4">{stageLabel(deal.stage)}</td>
                      <td className="py-4 text-right tabular-nums">{money(deal.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <Card title="Contacts">
        {contacts.length === 0 ? (
          <Empty>No contacts yet. They appear when you treat an email as a sales lead.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2 py-4 text-base">
                <span className="font-medium">{c.name || "—"} · {c.email}</span>
                <span className="text-muted">{c.company}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
