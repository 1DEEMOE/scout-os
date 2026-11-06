import { getPauseState, planSummary } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { modelStatus } from "@/server/engine";
import { Badge } from "../../ui";
import { Nav } from "./nav";
import { SignOutButton } from "../../sign-out-button";

export const dynamic = "force-dynamic";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, isManager, userId } = await orgContext(orgId);
  const [pause, plan] = await Promise.all([
    getPauseState({ actorUserId: userId, orgId }),
    planSummary({ actorUserId: userId, orgId }),
  ]);
  const model = modelStatus();
  const hasScout = plan.plan.features.includes("scout");
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <a href="/orgs" className="text-base text-muted hover:underline">Organizations</a>
          <span className="text-muted">/</span>
          <span className="text-lg font-medium">{org.name}</span>
          <Badge>{org.role}</Badge>
        </div>
        <SignOutButton />
      </div>
      {pause.paused && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/50 bg-danger/5 px-5 py-4 text-base sm:flex-row sm:items-center sm:justify-between">
          <span>
            <strong>Agents are paused.</strong> No agent takes any action and the lead bot hands nothing off. Paused by {pause.pausedByName}.
          </span>
          <a className="font-medium underline" href={`/orgs/${orgId}/settings#agents`}>Open Settings</a>
        </div>
      )}
      {model !== "live" && (
        <div role="status" className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-5 py-4 text-base">
          {model === "mock"
            ? "Demo mode: no live AI model is connected. Agents use a scripted MOCK model and propose no real actions."
            : "No AI model is configured on this server (ANTHROPIC_API_KEY), so agents can't plan tasks yet."}
        </div>
      )}
      <Nav orgId={orgId} isManager={isManager} isViewer={org.role === "viewer"} hasScout={hasScout} />
      <div className="pb-24 sm:pb-0">{children}</div>
    </div>
  );
}
