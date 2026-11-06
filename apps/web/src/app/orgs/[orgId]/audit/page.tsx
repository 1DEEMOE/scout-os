import { listAuditEvents, verifyAuditChain } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { notFound } from "next/navigation";
import { Badge, Empty, inputCls, PageTitle, quietButtonCls, TierBadge, When } from "../../../ui";

export const dynamic = "force-dynamic";

type Search = { action?: string; actor?: string; outcome?: string; before?: string };

export default async function AuditPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<Search> }) {
  const { orgId } = await params;
  const q = await searchParams;
  const { userId, isManager } = await orgContext(orgId);
  if (!isManager) notFound();
  const actorType = ["user", "agent", "system"].includes(q.actor ?? "") ? (q.actor as "user") : undefined;
  const outcome = ["success", "denied", "error"].includes(q.outcome ?? "") ? (q.outcome as "success") : undefined;
  const beforeSeq = q.before && /^\d+$/.test(q.before) ? Number(q.before) : undefined;
  const rows = await listAuditEvents({ actorUserId: userId, orgId, actionPrefix: q.action?.slice(0, 100) || undefined, actorType, outcome, beforeSeq, limit: 100 });
  const chain = await verifyAuditChain({ actorUserId: userId, orgId });
  const next = rows.length === 100 ? rows.at(-1)!.seq : null;
  const keep = new URLSearchParams(Object.entries({ action: q.action ?? "", actor: q.actor ?? "", outcome: q.outcome ?? "" }).filter(([, v]) => v));

  return (
    <div className="flex flex-col gap-4">
      <PageTitle sub="Append-only record of every action by people, agents and the system.">Audit log</PageTitle>
      <p className="-mt-2 text-sm">
        {chain.ok ? (
          <Badge tone="accent">tamper-evident chain intact · {chain.checked} entries{chain.legacy > 0 ? ` · ${chain.legacy} pre-chain` : ""}</Badge>
        ) : (
          <Badge tone="danger">chain broken at seq {chain.brokenAtSeq}: {chain.reason}</Badge>
        )}
      </p>
      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="flex flex-col gap-1 text-xs text-muted">Action starts with
          <input name="action" defaultValue={q.action} placeholder="tool. / approval." className={`${inputCls} w-48`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Actor
          <select name="actor" defaultValue={q.actor ?? ""} className={`${inputCls} w-32`}>
            <option value="">Any</option><option value="user">User</option><option value="agent">Agent</option><option value="system">System</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Outcome
          <select name="outcome" defaultValue={q.outcome ?? ""} className={`${inputCls} w-32`}>
            <option value="">Any</option><option value="success">Success</option><option value="denied">Denied</option><option value="error">Error</option>
          </select>
        </label>
        <button className={quietButtonCls}>Filter</button>
        <a className={quietButtonCls} href={`/api/orgs/${orgId}/audit.csv`}>Export CSV</a>
      </form>
      {rows.length === 0 ? (
        <Empty>No matching events.</Empty>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {/* Fixed minimum width: on phones the table scrolls sideways instead of squashing every row into a tall column. */}
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-normal">When</th><th className="py-2 pr-3 font-normal">Actor</th><th className="py-2 pr-3 font-normal">Action</th>
                <th className="py-2 pr-3 font-normal">Risk</th><th className="py-2 pr-3 font-normal">Outcome</th><th className="py-2 font-normal">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line align-top">
                  <td className="py-2 pr-3 whitespace-nowrap"><When date={r.at} /></td>
                  <td className="py-2 pr-3"><span className="text-muted">{r.actorType}</span> <span className="font-mono text-xs">{r.actorId.slice(0, 12)}</span></td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.action}</td>
                  <td className="py-2 pr-3"><TierBadge tier={r.tier} /></td>
                  <td className="py-2 pr-3"><Badge tone={r.outcome === "success" ? "muted" : "danger"}>{r.outcome}</Badge></td>
                  <td className="py-2 font-mono text-xs break-all text-muted">{r.target}{Object.keys(r.metadata).length ? ` ${JSON.stringify(r.metadata).slice(0, 200)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <a className={`${quietButtonCls} self-start`} href={`?${keep.toString()}${keep.size ? "&" : ""}before=${next}`}>Older events</a>}
    </div>
  );
}
