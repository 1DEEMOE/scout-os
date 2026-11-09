import { headers } from "next/headers";
import { approvalsForReview, getPack, getPauseState, listAgents, listMyOrgs, listRoutines, listThreads, planSummary, readPackId } from "@wos/core";
import { withTenant } from "@wos/db";
import { getSessionUser } from "@/server/auth";
import { isPlatformAdmin } from "@/server/platform-admin";
import { orgContext } from "@/server/org-context";
import { modelStatus } from "@/server/engine";
import { accentForGroup } from "../../accents";
import { PackAccent } from "../../pack-accent";
import { Shell } from "./nav";

export const dynamic = "force-dynamic";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, isManager, userId } = await orgContext(orgId);
  const who = { actorUserId: userId, orgId };
  const [pause, plan, agents, routines, threads, approvals, orgs, user] = await Promise.all([
    getPauseState(who),
    planSummary(who),
    listAgents(who),
    listRoutines(who),
    listThreads(who),
    approvalsForReview(who),
    listMyOrgs({ actorUserId: userId }),
    getSessionUser(await headers()),
  ]);
  const model = modelStatus();
  const packId = await withTenant(orgId, (tx) => readPackId(tx));
  const accent = accentForGroup(getPack(packId ?? "general").group);
  const banners = (
    <div className="mb-8 flex flex-col gap-3 empty:hidden">
      {pause.paused && (
        <div role="alert" className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-danger/40 bg-danger/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <span>
            <strong>Agents are paused.</strong> No agent takes any action and Scout hands nothing off. Paused by {pause.pausedByName}.
          </span>
          <a className="font-medium underline" href={`/orgs/${orgId}/settings#agents`}>Open Settings</a>
        </div>
      )}
      {model !== "live" && (
        <div role="status" className="rounded-[var(--radius-card)] border border-warn/40 bg-warn/5 px-5 py-4">
          {model === "mock"
            ? "Demo mode: no live AI model is connected. Agents use a scripted MOCK model and propose no real actions."
            : "No AI model is configured on this server (ANTHROPIC_API_KEY), so agents can't plan tasks yet."}
        </div>
      )}
    </div>
  );
  return (
    <Shell
      banners={banners}
      data={{
        orgId,
        orgName: org.name,
        role: org.role,
        isManager,
        isViewer: org.role === "viewer",
        hasScout: plan.plan.features.includes("scout"),
        waiting: approvals.open.length,
        teammates: agents.map((a) => ({ id: a.id, name: a.displayName, active: a.status === "active" })),
        routines: routines.slice(0, 6).map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
        threads: threads.slice(0, 5).map((t) => ({ id: t.id, title: t.title })),
        orgs: orgs.map((o) => ({ orgId: o.orgId, name: o.name, role: o.role })),
        user: { name: user?.name ?? "", email: user?.email ?? "" },
        isPlatformAdmin: isPlatformAdmin(user),
      }}
    >
      <PackAccent accent={accent} />
      {children}
    </Shell>
  );
}
