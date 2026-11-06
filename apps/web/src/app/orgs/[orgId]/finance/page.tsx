import { listInvoices, partitionInvoices } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../actions";
import { Badge, Card, Empty, money, PageTitle, When } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function FinancePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, org } = await orgContext(orgId);
  const invoices = await listInvoices({ actorUserId: userId, orgId });
  const today = new Date().toISOString().slice(0, 10);
  const { overdue, other } = partitionInvoices(invoices, today);
  const staff = org.role !== "viewer";
  const overdueTotal = overdue.reduce((s, i) => s + i.amountDueCents, 0);
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Invoices from your billing system. Reminders always need your OK before they go out.">Money · Invoices</PageTitle>
      {staff && (
        <div className="flex flex-wrap gap-3">
          {overdue.length > 0 ? (
            <ActionButton path="finance.chaseOverdue" input={{ orgId }} label={`Prepare reminders for ${overdue.length} overdue`} variant="primary" redirectToTask={{ orgId }} />
          ) : null}
          <ActionButton path="finance.sync" input={{ orgId }} label="Refresh invoices" busyLabel="Refreshing…" />
        </div>
      )}
      <Card title={`Overdue · ${overdue.length} · ${money(overdueTotal)}`}>
        {overdue.length === 0 && invoices.length === 0 ? (
          <Empty action={staff ? <span className="text-base text-muted">Connect Stripe in Settings, then refresh.</span> : undefined}>
            No invoices yet. When overdue bills appear, you can prepare reminders in one tap.
          </Empty>
        ) : overdue.length === 0 ? (
          <Empty>Nothing overdue. Nice work.</Empty>
        ) : (
          <>
            <ul className="divide-y divide-line sm:hidden">
              {overdue.map((i) => (
                <li key={i.id} className="flex flex-col gap-2 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-medium">{i.number ?? i.externalId}</div>
                      <div className="text-base text-muted">{i.customerName || i.customerEmail}</div>
                    </div>
                    <div className="text-lg font-semibold tabular-nums">{money(i.amountDueCents, i.currency)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger">overdue</Badge>
                    <span className="text-sm text-muted">due {i.dueDate}</span>
                    {i.provider === "fake" && <Badge tone="warn">MOCK</Badge>}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-base">
                <thead className="text-muted">
                  <tr className="border-b border-line">
                    <th className="py-3 pr-4 font-normal">Invoice</th>
                    <th className="py-3 pr-4 font-normal">Customer</th>
                    <th className="py-3 pr-4 font-normal">Due</th>
                    <th className="py-3 pr-4 font-normal">Status</th>
                    <th className="py-3 text-right font-normal">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {overdue.map((i) => (
                    <tr key={i.id} className="border-b border-line">
                      <td className="py-4 pr-4">{i.number ?? i.externalId} {i.provider === "fake" && <Badge tone="warn">MOCK</Badge>}</td>
                      <td className="py-4 pr-4">{i.customerName || i.customerEmail}</td>
                      <td className="py-4 pr-4">{i.dueDate ?? "—"}</td>
                      <td className="py-4 pr-4">
                        <Badge tone="danger">overdue</Badge>
                        {i.lastReminderAt && <span className="ml-2 text-sm text-muted">reminded <When date={i.lastReminderAt} /></span>}
                      </td>
                      <td className="py-4 text-right tabular-nums">{money(i.amountDueCents, i.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      {other.length > 0 && (
        <Card title={`Paid and upcoming · ${other.length}`}>
          <ul className="divide-y divide-line sm:hidden">
            {other.map((i) => (
              <li key={i.id} className="flex flex-col gap-2 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-medium">{i.number ?? i.externalId}</div>
                    <div className="text-base text-muted">{i.customerName || i.customerEmail}</div>
                  </div>
                  <div className="text-lg font-semibold tabular-nums">{money(i.amountDueCents, i.currency)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.status === "paid" ? "accent" : "muted"}>{i.status}</Badge>
                  {i.dueDate && <span className="text-sm text-muted">due {i.dueDate}</span>}
                  {i.provider === "fake" && <Badge tone="warn">MOCK</Badge>}
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-base">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="py-3 pr-4 font-normal">Invoice</th>
                  <th className="py-3 pr-4 font-normal">Customer</th>
                  <th className="py-3 pr-4 font-normal">Due</th>
                  <th className="py-3 pr-4 font-normal">Status</th>
                  <th className="py-3 text-right font-normal">Amount</th>
                </tr>
              </thead>
              <tbody>
                {other.map((i) => (
                  <tr key={i.id} className="border-b border-line">
                    <td className="py-4 pr-4">{i.number ?? i.externalId} {i.provider === "fake" && <Badge tone="warn">MOCK</Badge>}</td>
                    <td className="py-4 pr-4">{i.customerName || i.customerEmail}</td>
                    <td className="py-4 pr-4">{i.dueDate ?? "—"}</td>
                    <td className="py-4 pr-4">
                      <Badge tone={i.status === "paid" ? "accent" : "muted"}>{i.status}</Badge>
                      {i.lastReminderAt && <span className="ml-2 text-sm text-muted">reminded <When date={i.lastReminderAt} /></span>}
                    </td>
                    <td className="py-4 text-right tabular-nums">{money(i.amountDueCents, i.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
