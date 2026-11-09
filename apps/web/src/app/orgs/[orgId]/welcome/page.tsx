import { getBusinessProfile, getOnboardingState, listIntegrations, listPacks } from "@wos/core";
import { redirect } from "next/navigation";
import { orgContext } from "@/server/org-context";
import { stepFromOnboarding } from "./progress";
import { Welcome } from "./welcome";

export const dynamic = "force-dynamic";
export const metadata = { title: "Welcome" };

/** Three short, skippable steps with smart defaults, ending in a first briefing. */
export default async function WelcomePage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ step?: string; zip?: string }> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { userId, isManager } = await orgContext(orgId);
  if (!isManager) redirect(`/orgs/${orgId}`);
  const who = { actorUserId: userId, orgId };
  const [state, integrations, profile] = await Promise.all([getOnboardingState(who), listIntegrations(who), getBusinessProfile(who).catch(() => null)]);
  const counties = (profile?.serviceArea as { counties?: { county: string; state: string }[] } | undefined)?.counties ?? [];
  const serviceArea = counties.length ? counties.map((c) => `${c.county} County, ${c.state}`).join(" and ") : null;
  if (state.completedAt) redirect(`/orgs/${orgId}`);
  const asked = Number(sp.step);
  const step = asked === 1 || asked === 2 || asked === 3 ? asked : stepFromOnboarding(state.step);
  return (
    <Welcome
      orgId={orgId}
      step={step}
      name={state.orgName}
      industry={state.industry ?? "roofing"}
      packs={listPacks().map((p) => ({ id: p.id, label: p.label, group: p.group, summary: p.summary, watchLine: p.watchLine, weather: p.signals.includes("weather") }))}
      zip={(sp.zip ?? "").replace(/\D/g, "").slice(0, 5)}
      serviceArea={serviceArea}
      hasDemoData={state.hasDemoData}
      emailConnectAvailable={!!process.env.GOOGLE_CLIENT_ID}
      emailConnected={integrations.some((i) => i.provider === "google" && i.status === "active")}
    />
  );
}
