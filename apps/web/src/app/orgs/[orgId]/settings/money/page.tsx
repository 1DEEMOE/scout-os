import { moneySnapshot } from "@wos/core";
import { ActionForm } from "../../../../actions";
import { orgContext } from "@/server/org-context";
import { Card, inputCls, money, PageTitle } from "../../../../ui";

export const dynamic = "force-dynamic";

export default async function MoneySettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager } = await orgContext(orgId);
  const digest = await moneySnapshot({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Invoices from the last 7 days, in dollars. Nothing here pays a bill. Auto-pay stays off.">Money digest</PageTitle>
      <Card title="This week">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-base text-muted">Open</dt>
            <dd className="text-2xl font-semibold">{money(digest.openCents)}</dd>
          </div>
          <div>
            <dt className="text-base text-muted">Collected</dt>
            <dd className="text-2xl font-semibold">{money(digest.collectedCents)}</dd>
          </div>
          <div>
            <dt className="text-base text-muted">Outstanding</dt>
            <dd className="text-2xl font-semibold">{money(digest.outstandingCents)}</dd>
          </div>
        </dl>
        <p className="mt-6 text-base">{digest.weeklyCapNote}</p>
        <p className="mt-2 text-base text-muted">Last 7 days. Weekly cap: {digest.weeklyCapCents === null ? "not set" : money(digest.weeklyCapCents)}. Auto-pay is off.</p>
      </Card>
      {isManager && (
        <Card title="Weekly cap">
          <ActionForm path="kimi.moneyCap" fixed={{ orgId }} submitLabel="Save cap">
            <label htmlFor="weekly-cap" className="text-base">Cap in dollars. This does not pay anything.</label>
            <input id="weekly-cap" name="weeklyCapDollars" type="number" min={0} step="0.01" required defaultValue={digest.weeklyCapCents === null ? 0 : digest.weeklyCapCents / 100} className={inputCls} />
            <p className="text-sm text-muted">Dollars. 500 is $500.00. Saving the cap does not turn on auto-pay.</p>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
