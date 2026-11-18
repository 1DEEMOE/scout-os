import Link from "next/link";
import { listContactsEnriched, listDeals, listPipeline, OPEN_STAGES, pipelineForecast, type ContactScore, type DealView } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Badge, Card, Empty, money, PageTitle, stageLabel } from "../../../ui";

export const dynamic = "force-dynamic";

function ScoreChip({ score }: { score: ContactScore }) {
  const tone = score.grade === "hot" ? "accent" : score.grade === "warm" ? "warn" : "muted";
  return <Badge tone={tone}>{score.grade} · {score.score}</Badge>;
}

function DealCard({ orgId, deal }: { orgId: string; deal: DealView }) {
  return (
    <Link
      href={`/orgs/${orgId}/sales/deals/${deal.id}`}
      className="block rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-accent/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{deal.name}</div>
          <div className="truncate text-sm text-muted">{deal.contactName || deal.contactEmail || "No contact"}</div>
        </div>
        <div className="shrink-0 text-right font-semibold tabular-nums">{money(deal.amountCents)}</div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>{Math.round(deal.probabilityBps / 100)}%</span>
        {deal.expectedClose && <span>· closes {deal.expectedClose}</span>}
        {deal.source === "web_form" && <Badge tone="accent">web form</Badge>}
      </div>
    </Link>
  );
}

export default async function SalesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId } = await orgContext(orgId);
  const [pipeline, forecast, contacts, external] = await Promise.all([
    listPipeline({ actorUserId: userId, orgId }),
    pipelineForecast({ actorUserId: userId, orgId }),
    listContactsEnriched({ actorUserId: userId, orgId }),
    listDeals({ actorUserId: userId, orgId }),
  ]);

  const open = pipeline.filter((d) => (OPEN_STAGES as readonly string[]).includes(d.stage));
  const closed = pipeline.filter((d) => !(OPEN_STAGES as readonly string[]).includes(d.stage));

  return (
    <div className="flex flex-col gap-8">
      <PageTitle
        sub="Your pipeline, weighted forecast, and every customer in one place. Web-form leads land here automatically."
      >
        Sales
      </PageTitle>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card title="Open pipeline">
          <p className="text-2xl font-semibold tabular-nums">{money(forecast.open.totalCents)}</p>
          <p className="mt-1 text-sm text-muted">{forecast.open.count} open {forecast.open.count === 1 ? "deal" : "deals"}</p>
        </Card>
        <Card title="Weighted forecast">
          <p className="text-2xl font-semibold tabular-nums">{money(forecast.open.weightedCents)}</p>
          <p className="mt-1 text-sm text-muted">Adjusted by each stage&apos;s win probability</p>
        </Card>
        <Card title="Won this month">
          <p className="text-2xl font-semibold tabular-nums">{money(forecast.wonThisMonth.totalCents)}</p>
          <p className="mt-1 text-sm text-muted">
            {forecast.wonThisMonth.count} won · {forecast.lostThisMonth.count} lost
          </p>
        </Card>
        <Card title="Contacts">
          <p className="text-2xl font-semibold tabular-nums">{contacts.length}</p>
          <p className="mt-1 text-sm text-muted">{contacts.filter((c) => c.score.grade === "hot").length} hot right now</p>
        </Card>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Pipeline</h2>
        <Link
          href={`/orgs/${orgId}/sales/new`}
          className="accent-fill inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-base font-medium text-on-accent transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98]"
        >
          + New deal
        </Link>
      </div>

      {open.length === 0 ? (
        <Empty action={<Link className="font-medium text-accent underline" href={`/orgs/${orgId}/sales/new`}>Open your first deal</Link>}>
          No open deals yet. Add one yourself, turn on the lead form for your website, or treat an email as a sales lead.
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {OPEN_STAGES.map((stage) => {
            const inStage = open.filter((d) => d.stage === stage);
            const stageInfo = forecast.stages.find((s) => s.stage === stage);
            return (
              <section key={stage} className="flex flex-col gap-3">
                <header className="flex items-baseline justify-between gap-2 px-1">
                  <h3 className="font-medium">{stageLabel(stage)}</h3>
                  <span className="text-sm text-muted tabular-nums">
                    {inStage.length} · {money(stageInfo?.totalCents ?? 0)}
                  </span>
                </header>
                <div className="flex flex-col gap-3">
                  {inStage.map((d) => (
                    <DealCard key={d.id} orgId={orgId} deal={d} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {closed.length > 0 && (
        <Card title="Recently decided">
          <ul className="divide-y divide-line">
            {closed.slice(0, 10).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-base">
                <Link href={`/orgs/${orgId}/sales/deals/${d.id}`} className="font-medium text-accent underline">
                  {d.name}
                </Link>
                <span className="flex items-center gap-3">
                  <Badge tone={d.stage === "won" ? "accent" : "muted"}>{stageLabel(d.stage)}</Badge>
                  <span className="tabular-nums">{money(d.amountCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Contacts">
        {contacts.length === 0 ? (
          <Empty>No contacts yet. They appear from deals, the lead form, and the inbox.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-4 text-base">
                <Link href={`/orgs/${orgId}/sales/contacts/${c.id}`} className="font-medium text-accent underline">
                  {c.name || c.email || "Unnamed"}
                </Link>
                <span className="flex items-center gap-3">
                  {c.openDealCount > 0 && <Badge tone="accent">{c.openDealCount} open {c.openDealCount === 1 ? "deal" : "deals"}</Badge>}
                  <ScoreChip score={c.score} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {external.length > 0 && (
        <Card title="Synced from your CRM">
          <ul className="divide-y divide-line">
            {external.map(({ deal, contactEmail, contactName }) => (
              <li key={deal.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-base">
                <span>
                  <span className="font-medium">{deal.name}</span>{" "}
                  <span className="text-muted">{contactName || contactEmail}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge>{stageLabel(deal.stage)}</Badge>
                  {deal.provider === "fake" && <Badge tone="warn">MOCK</Badge>}
                  <span className="tabular-nums">{money(deal.amountCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
