import { briefingSourceLabel, type Briefing, type RoutineRunRow } from "@wos/core";
import { Badge, Card, Empty } from "../../../ui";

export function fmtIn(date: Date | string | null | undefined, tz: string): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

const RUN_TONE: Record<string, "muted" | "accent" | "danger" | "warn"> = { succeeded: "accent", failed: "danger", skipped: "warn", running: "muted" };
const SKIP_TEXT: Record<string, string> = {
  agents_paused: "skipped: agents are paused",
  quota_exceeded: "skipped: monthly routine runs used up",
  routine_paused: "skipped: routine is paused",
};

export function RunStatus({ run }: { run: Pick<RoutineRunRow, "status" | "skipReason"> }) {
  return <Badge tone={RUN_TONE[run.status] ?? "muted"}>{run.status === "skipped" && run.skipReason ? SKIP_TEXT[run.skipReason] : run.status}</Badge>;
}

export function BriefingView({ briefing }: { briefing: Briefing }) {
  return (
    <div className="flex flex-col gap-4">
      {briefing.sections.map((s) => (
        <Card
          key={s.key}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {s.title} {s.status === "ok" ? <Badge tone={s.count ? "warn" : "muted"}>{s.count}</Badge> : <Badge>unavailable</Badge>}
            </span>
          }
        >
          {s.status === "unavailable" ? (
            <p className="text-sm text-muted">{s.reason}</p>
          ) : s.items.length === 0 ? (
            <Empty>Nothing here today.</Empty>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {s.items.map((it, i) => (
                <li key={i}>
                  {it.href ? <a className="underline" href={it.href}>{it.label}</a> : it.label}
                  {it.detail && <span className="text-muted"> · {it.detail}</span>}
                </li>
              ))}
              {s.count > s.items.length && <li className="text-muted">…and {s.count - s.items.length} more</li>}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Source: {s.sources.length ? s.sources.map(briefingSourceLabel).join(", ") : "none"}</p>
        </Card>
      ))}
    </div>
  );
}
