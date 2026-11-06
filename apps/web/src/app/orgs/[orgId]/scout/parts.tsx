import { Badge, Card } from "../../../ui";

/** Storm report times are UTC in the source, so they're shown in UTC and say so. */
export function Utc({ date }: { date: Date | string }) {
  const d = typeof date === "string" ? new Date(date) : date;
  return <time dateTime={d.toISOString()}>{d.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC</time>;
}

const SYSTEM_ACTORS: Record<string, string> = {
  demo: "Demo loader",
  inbox: "Inbox sync (they emailed you)",
  "system:inbox": "Inbox sync (they emailed you)",
  "pipeline-handoff": "Pipeline handoff",
  retention: "Retention cleanup",
};

/** A person's name for user ids; a plain label for system and agent actors. */
export function actorName(names: Map<string, string>, type: string, id: string): string {
  if (type === "agent") return "Scout agent";
  if (type === "system") return SYSTEM_ACTORS[id] ?? "System";
  return names.get(id) ?? SYSTEM_ACTORS[id] ?? "Former member";
}

export const STAGE_LABEL: Record<string, string> = {
  prospect: "Prospect · not contacted",
  engaged: "Engaged",
  qualified: "Qualified",
  opportunity: "In Pipeline",
  disqualified: "Ruled out",
};
const STAGE_TONE: Record<string, "muted" | "accent" | "danger" | "warn"> = { prospect: "muted", engaged: "warn", qualified: "accent", opportunity: "accent", disqualified: "danger" };

export function StageBadge({ stage }: { stage: string }) {
  return <Badge tone={STAGE_TONE[stage] ?? "muted"}>{STAGE_LABEL[stage] ?? stage}</Badge>;
}

/** Demo rows are labelled everywhere they appear (directive §13). */
export function DemoBadge() {
  return (
    <span title="Sample data for trying Scout. Not a real finding.">
      <Badge tone="warn">DEMO</Badge>
    </span>
  );
}

const BASIS: Record<string, { label: string; tone: "muted" | "accent" | "warn"; title: string }> = {
  observed: { label: "Observed", tone: "accent", title: "Counted from records in Scout OS." },
  "customer-reported": { label: "Customer-reported", tone: "warn", title: "A number you typed in. Not checked." },
  estimated: { label: "Estimated", tone: "muted", title: "Calculated from numbers you typed in. Not a measurement." },
};
export function BasisBadge({ basis }: { basis: string }) {
  const b = BASIS[basis] ?? BASIS.estimated!;
  return (
    <span title={b.title}>
      <Badge tone={b.tone}>{b.label}</Badge>
    </span>
  );
}

const FACTORS: [string, string][] = [
  ["signalRelevance", "Storm report"],
  ["freshness", "How recent"],
  ["geographicFit", "Distance"],
  ["dataReliability", "Record quality"],
  ["verifiedEngagement", "Contact from them"],
];
type Factor = { points: number; max: number; why: string };

/** Score with its parts. Labelled as a heuristic everywhere it appears. */
export function ScoreCell({ score, breakdown }: { score: number; breakdown: Record<string, unknown> }) {
  const parts = FACTORS.map(([k, label]) => ({ k, label, f: breakdown[k] as Factor | undefined })).filter((p) => p.f);
  return (
    <div className="flex w-full min-w-0 flex-col gap-1" title={parts.map((p) => `${p.label}: ${p.f!.points}/${p.f!.max} (${p.f!.why})`).join("\n")}>
      <span className="text-sm">
        <span className="font-semibold tabular-nums">{score}</span>
        <span className="text-muted"> / 100</span>
      </span>
      <div className="flex h-1.5 w-full overflow-hidden rounded bg-line" aria-hidden>
        {parts.map((p, i) => (
          <div key={p.k} className={i % 2 ? "bg-accent/60" : "bg-accent"} style={{ width: `${p.f!.points}%` }} />
        ))}
      </div>
    </div>
  );
}

export function ScoreTable({ score, breakdown }: { score: number; breakdown: Record<string, unknown> }) {
  return (
    <table className="w-full text-sm">
      <caption className="mb-2 text-left text-xs text-muted">Heuristic score from fixed rules. It is not a probability.</caption>
      <tbody className="divide-y divide-line">
        {FACTORS.map(([k, label]) => {
          const f = breakdown[k] as Factor | undefined;
          if (!f) return null;
          return (
            <tr key={k}>
              <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted">{label}</th>
              <td className="py-1.5 pr-3">{f.why}</td>
              <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{f.points} / {f.max}</td>
            </tr>
          );
        })}
        <tr>
          <th scope="row" className="py-1.5 pr-3 text-left">Total</th>
          <td />
          <td className="py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">{score} / 100</td>
        </tr>
      </tbody>
    </table>
  );
}

export function UpgradeNotice({ orgId, planLabel }: { orgId: string; planLabel: string }) {
  return (
    <Card title="Scout lead intelligence">
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Scout matches your own customer and prospect records against public NOAA storm reports in the area you serve, scores each match with
          rules you can read, and explains why. It never contacts anyone on its own.
        </p>
        <p className="text-muted">It isn&apos;t included in the {planLabel} plan. It&apos;s part of Scout Pro and Enterprise.</p>
        <a href={`/orgs/${orgId}/billing`} className="self-start underline">See plans in Billing</a>
      </div>
    </Card>
  );
}

export function ScoutTabs({ orgId, active, role }: { orgId: string; active: "feed" | "signals" | "setup" | "contacts"; role: string }) {
  // Contact rules are staff-only (viewers get a 404), so viewers don't get the tab.
  const items: [typeof active, string, string][] = [
    ["feed", "Opportunities", ""],
    ["signals", "Storm reports", "/signals"],
    ...(role === "viewer" ? [] : [["contacts", "Contact rules", "/contacts"] as [typeof active, string, string]]),
    ["setup", "Setup", "/setup"],
  ];
  return (
    <nav aria-label="Scout" className="mb-4 flex flex-wrap gap-2 text-sm">
      {items.map(([k, label, href]) => (
        <a key={k} href={`/orgs/${orgId}/scout${href}`} aria-current={active === k ? "page" : undefined}
          className={`rounded-md border px-3 py-1 ${active === k ? "border-accent font-medium text-accent" : "border-line text-muted hover:text-ink"}`}>
          {label}
        </a>
      ))}
    </nav>
  );
}
