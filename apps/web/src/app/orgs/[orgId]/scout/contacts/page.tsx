import { listContactRules, listMembers, planSummary } from "@wos/core";
import { notFound } from "next/navigation";
import { orgContext } from "@/server/org-context";
import { ActionButton, ActionForm } from "../../../../actions";
import { Badge, Card, Empty, inputCls, PageTitle, When } from "../../../../ui";
import { actorName, ScoutTabs } from "../parts";

export const dynamic = "force-dynamic";

const BASIS: Record<string, string> = { existing_customer: "Existing customer", inbound_inquiry: "They contacted you", express_written_consent: "Written consent" };
const REASON: Record<string, string> = { opt_out: "Asked not to be contacted", bounce: "Bounced", complaint: "Complaint", manual: "Added by staff" };

export default async function ContactRulesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager, org } = await orgContext(orgId);
  // Contact rules list people's emails; the core only lets staff read them.
  if (org.role === "viewer") notFound();
  const [plan, rules, members] = await Promise.all([planSummary({ actorUserId: userId, orgId }), listContactRules({ actorUserId: userId, orgId }), listMembers({ actorUserId: userId, orgId })]);
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const scout = plan.plan.features.includes("scout");
  return (
    <div>
      <PageTitle sub="Having someone's email doesn't mean they agreed to hear from you. Scout prospects are only emailed with a recorded permission, and never if they're on the do-not-contact list.">Contact rules</PageTitle>
      {scout && <ScoutTabs orgId={orgId} active="contacts" role={org.role} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={`Do-not-contact (${rules.suppressed.length})`}>
          <ActionForm path="scout.suppress" fixed={{ orgId }} submitLabel="Add" resetOnSuccess>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
              <label className="flex flex-col gap-1 text-sm">Email<input name="email" type="email" required className={inputCls} /></label>
              <label className="flex flex-col gap-1 text-sm">Reason
                <select name="reason" className={inputCls} defaultValue="opt_out">
                  {Object.entries(REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </div>
          </ActionForm>
          <p className="mt-2 text-xs text-muted">Anyone on staff can add. Entries can&apos;t be removed in the app. Adding someone also withdraws any permission.</p>
          {rules.suppressed.length === 0 ? <div className="mt-3"><Empty>Nobody yet.</Empty></div> : (
            <ul className="mt-3 divide-y divide-line text-sm">
              {rules.suppressed.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="break-all">{s.value}</span>
                  <span className="flex items-center gap-2 text-xs text-muted"><Badge tone="danger">{REASON[s.reason]}</Badge>{actorName(names, "user", s.addedBy)} · <When date={s.createdAt} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Permission to email (${rules.permissions.length})`}>
          {isManager && scout ? (
            <ActionForm path="scout.recordPermission" fixed={{ orgId }} submitLabel="Record permission" resetOnSuccess>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">Email<input name="email" type="email" required className={inputCls} /></label>
                <label className="flex flex-col gap-1 text-sm">Basis
                  <select name="basis" className={inputCls} defaultValue="existing_customer">
                    {Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">Evidence
                <input name="evidence" required minLength={5} maxLength={2000} placeholder="Customer since 2021, invoice #1043" className={inputCls} />
              </label>
            </ActionForm>
          ) : (
            <p className="text-sm text-muted">{scout ? "Managers record permissions." : "Permissions are part of Scout."} An email from someone records one automatically.</p>
          )}
          {rules.permissions.length === 0 ? <div className="mt-3"><Empty>None recorded.</Empty></div> : (
            <ul className="mt-3 divide-y divide-line text-sm">
              {rules.permissions.map((p) => (
                <li key={p.id} className="flex flex-col gap-1 py-2">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all">{p.value}</span>
                    <Badge tone="accent">{BASIS[p.basis]}</Badge>
                  </span>
                  <span className="text-xs text-muted">{p.evidence} · {actorName(names, "user", p.recordedBy)} · <When date={p.recordedAt} /></span>
                  {scout && <ActionButton path="scout.revokePermission" input={{ orgId, email: p.value }} label="Withdraw" confirm={`Withdraw permission to email ${p.value}?`} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
