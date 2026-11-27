import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, contact360 } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { Badge, Card, money, PageTitle, When } from "../../../../../ui";
import { ContactNotes } from "./contact-notes";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  deal: "Deal",
  external_deal: "Sync",
  invoice: "Invoice",
  message: "Email",
  job: "Job",
  lead_form: "Web form",
};

function ScoreCard({ score }: { score: { score: number; grade: string; reasons: { id: string; points: number; label: string }[] } }) {
  return (
    <Card title="Lead score">
      <p className="text-2xl font-semibold tabular-nums">
        {score.score} <span className="text-base font-normal text-muted">· {score.grade}</span>
      </p>
      {score.reasons.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No signals yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          {score.reasons.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <span>{r.label}</span>
              <span className="tabular-nums text-muted">+{r.points}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default async function ContactPage({ params }: { params: Promise<{ orgId: string; contactId: string }> }) {
  const { orgId, contactId } = await params;
  const { userId, org } = await orgContext(orgId);
  const data = await contact360({ actorUserId: userId, orgId, contactId }).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const c = data.contact;

  return (
    <div className="flex flex-col gap-8">
      <PageTitle
        sub={
          <>
            <Link href={`/orgs/${orgId}/sales`} className="text-accent underline">
              Sales
            </Link>{" "}
            · everything we know about this person
          </>
        }
      >
        {c.name || c.email || "Unnamed contact"}
      </PageTitle>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6">
          <Card title="Details">
            <dl className="flex flex-col gap-2 text-base">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Email</dt>
                <dd className="break-all text-right">{c.email ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Phone</dt>
                <dd className="text-right">{c.phone ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Company</dt>
                <dd className="text-right">{c.company ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Source</dt>
                <dd className="text-right">{(c.source as string) === "web_form" ? "Web lead form" : c.source}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Since</dt>
                <dd className="text-right">
                  <When date={c.createdAt} />
                </dd>
              </div>
            </dl>
          </Card>
          <ScoreCard score={data.score} />
        </div>

        <div className="flex flex-col gap-6">
          <Card title={`Open deals (${data.openDeals.length})`}>
            {data.openDeals.length === 0 ? (
              <p className="text-sm text-muted">No open deals.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.openDeals.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                    <Link className="font-medium text-accent underline" href={`/orgs/${orgId}/sales/deals/${d.id}`}>
                      {d.name}
                    </Link>
                    <span className="tabular-nums">{money(d.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {data.closedDeals.length > 0 && (
            <Card title={`Closed deals (${data.closedDeals.length})`}>
              <ul className="divide-y divide-line">
                {data.closedDeals.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                    <Link className="font-medium text-accent underline" href={`/orgs/${orgId}/sales/deals/${d.id}`}>
                      {d.name}
                    </Link>
                    <span className="flex items-center gap-2">
                      <Badge tone={d.stage === "won" ? "accent" : "muted"}>{d.stage}</Badge>
                      <span className="tabular-nums">{money(d.amountCents)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <ContactNotes orgId={orgId} contactId={contactId} canWrite={org.role !== "viewer"} notes={data.notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, authorName: n.authorName }))} />
        </div>

        <Card title="Timeline">
          {data.timeline.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet. Deals, notes, emails, invoices, and jobs show up here.</p>
          ) : (
            <ol className="flex flex-col gap-0 border-l-2 border-line pl-4">
              {data.timeline.map((t, i) => (
                <li key={`${t.kind}-${t.at}-${i}`} className="relative pb-5">
                  <span className="absolute -left-[23px] top-1.5 h-3 w-3 rounded-full border-2 border-line bg-surface" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={t.kind === "lead_form" ? "accent" : "muted"}>{KIND_LABEL[t.kind] ?? t.kind}</Badge>
                    <span className="text-sm text-muted">
                      <When date={t.at} />
                    </span>
                  </div>
                  <div className="mt-1 text-base">
                    {t.href ? (
                      <Link className="text-accent underline" href={t.href}>
                        {t.title}
                      </Link>
                    ) : (
                      t.title
                    )}
                  </div>
                  {t.detail && <div className="mt-0.5 text-sm text-muted">{t.detail}</div>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
