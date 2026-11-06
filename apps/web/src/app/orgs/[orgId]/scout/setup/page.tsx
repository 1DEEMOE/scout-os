import { getBusinessProfile, listMembers, listSources, planSummary, vertical } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../../actions";
import { Badge, Card, Empty, PageTitle, When } from "../../../../ui";
import { actorName, DemoBadge, ScoutTabs, UpgradeNotice } from "../parts";
import { ProfileForm, ProspectImportForm, StormUploadForm } from "../forms";

export const dynamic = "force-dynamic";

const KIND: Record<string, string> = { noaa_spc_storm_reports: "Storm reports", customer_import: "Your list", crm_contacts: "CRM" };

export default async function SetupPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager, org } = await orgContext(orgId);
  const plan = await planSummary({ actorUserId: userId, orgId });
  if (!plan.plan.features.includes("scout")) return <UpgradeNotice orgId={orgId} planLabel={plan.plan.label} />;
  const [profile, sources, members] = await Promise.all([getBusinessProfile({ actorUserId: userId, orgId }), listSources({ actorUserId: userId, orgId }), listMembers({ actorUserId: userId, orgId })]);
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const rowsLimit = plan.plan.limits["scout.prospect_rows"];
  return (
    <div>
      <PageTitle sub="Three steps: describe your business, add storm reports, add the people you already know.">Scout setup</PageTitle>
      <ScoutTabs orgId={orgId} active="setup" role={org.role} />
      <div className="flex flex-col gap-4">
        <Card
          title={<span className="flex flex-wrap items-center gap-2">1. Business profile {profile && <Badge tone={profile.status === "reviewed" ? "accent" : "warn"}>{profile.status === "reviewed" ? "reviewed" : "draft · not used yet"}</Badge>}</span>}
        >
          <ProfileForm orgId={orgId} profile={profile} suggestedServices={vertical("roofing").suggestedServices} canEdit={isManager} />
          {profile?.status === "draft" && isManager && (
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              <p className="text-sm">Check the area and services above. Once reviewed, Scout can scan using them.</p>
              <ActionButton path="scout.reviewProfile" input={{ orgId }} label="I've reviewed this profile" variant="primary" />
            </div>
          )}
          {profile?.status === "reviewed" && <p className="mt-3 text-xs text-muted">Reviewed by {actorName(names, "user", profile.reviewedBy ?? "")} on <When date={profile.reviewedAt} />. Saving changes puts it back to draft.</p>}
        </Card>
        {isManager ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="2. Storm reports">
              <p className="mb-3 text-sm text-muted">
                Download a day&apos;s CSV from the NOAA Storm Prediction Center storm reports page and upload it here. Scout can&apos;t fetch it for you yet.
              </p>
              <StormUploadForm orgId={orgId} />
            </Card>
            <Card title="3. Your prospects">
              <p className="mb-3 text-sm text-muted">Past customers, people who asked for quotes, lists you have the right to use. {rowsLimit !== null && <>This month: {plan.usage["scout.prospect_rows"].toLocaleString("en-US")} of {rowsLimit.toLocaleString("en-US")} rows.</>}</p>
              <ProspectImportForm orgId={orgId} />
            </Card>
          </div>
        ) : (
          <p className="text-sm text-muted">Managers add storm reports and prospect lists.</p>
        )}
        <Card title="Data sources">
          {sources.length === 0 ? <Empty>Nothing added yet.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {sources.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 py-2">
                  <span className="flex flex-wrap items-center gap-2"><Badge>{KIND[s.kind]}</Badge> <span className="font-medium">{s.label}</span> {s.demo && <DemoBadge />} <span className="text-muted">{s.rowCount} rows</span></span>
                  <span className="text-xs text-muted">Rights: {s.usageRights}</span>
                  {s.attestedBy && <span className="text-xs text-muted">Confirmed by {actorName(names, "user", s.attestedBy)} on <When date={s.attestedAt} /></span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
