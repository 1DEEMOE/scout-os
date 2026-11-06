/* Controls are at least 44px tall: comfortable on phones, well over the 24px AA minimum. */
export const inputCls =
  "min-h-11 w-full rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2.5 text-base text-ink placeholder:text-muted outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15";
export const buttonCls =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-base font-medium text-on-accent transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] disabled:opacity-50";
export const quietButtonCls =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-base text-ink transition-colors duration-150 hover:bg-soft disabled:opacity-50";
export const dangerButtonCls =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-danger/40 bg-surface px-4 py-2.5 text-base text-danger transition-colors duration-150 hover:bg-danger/10 disabled:opacity-50";

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-base text-danger">
      {message}
    </p>
  );
}

/** Risk colours by tier (0–4). Labels and rules are unchanged; only the colours use the tokens. */
export const TIER_STYLE: Record<number, string> = {
  0: "border-line text-muted",
  1: "border-line text-muted",
  2: "border-warn/40 bg-warn/5 text-warn",
  3: "border-caution/40 bg-caution/5 text-caution",
  4: "border-danger/50 bg-danger/5 text-danger",
};
/** The coloured rail on approval cards. */
export const TIER_RAIL: Record<number, string> = { 0: "bg-line", 1: "bg-line", 2: "bg-warn", 3: "bg-caution", 4: "bg-danger" };
const TIER_NAME = ["read-only", "internal", "external", "financial", "destructive"];

/** Plain-language risk label for list titles. Full tier stays in details. */
export function NeedOkBadge({ tier }: { tier: number }) {
  const label =
    tier >= 4 ? "Needs two people to OK" : tier >= 2 ? "Needs your OK" : "Low risk";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm whitespace-nowrap ${TIER_STYLE[tier] ?? ""}`}>
      {label}
    </span>
  );
}

export function TierBadge({ tier }: { tier: number }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm whitespace-nowrap ${TIER_STYLE[tier] ?? ""}`}>
      Risk level {tier} · {TIER_NAME[tier]}
    </span>
  );
}

export function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" | "danger" | "warn" }) {
  const cls = {
    muted: "border-line text-muted",
    accent: "border-accent/40 bg-accent-soft text-accent",
    danger: "border-danger/40 bg-danger/5 text-danger",
    warn: "border-warn/40 bg-warn/5 text-warn",
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm whitespace-nowrap ${cls}`}>{children}</span>;
}

/** Everything produced by a fake provider or model is labelled, per project rules. */
export function MockBadge() {
  return <Badge tone="warn">MOCK</Badge>;
}

export function Card({ title, children, actions }: { title?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-6 sm:p-7">
      {(title || actions) && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-xl font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-dashed border-line bg-paper/60 px-6 py-10">
      <p className="text-base text-muted">{children}</p>
      {action}
    </div>
  );
}

export function PageTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h1 className="text-display font-semibold">{children}</h1>
      {sub && <p className="mt-3 max-w-[65ch] text-base text-muted">{sub}</p>}
    </div>
  );
}

const STATE_TONE: Record<string, "muted" | "accent" | "danger" | "warn"> = {
  COMPLETED: "accent",
  FAILED: "danger",
  ESCALATED: "danger",
  WAITING_FOR_APPROVAL: "warn",
  RETRY_SCHEDULED: "warn",
};

const STATE_LABEL: Record<string, string> = {
  COMPLETED: "done",
  FAILED: "failed",
  ESCALATED: "needs help",
  WAITING_FOR_APPROVAL: "waiting for your OK",
  RETRY_SCHEDULED: "trying again",
  RUNNING: "running",
  QUEUED: "queued",
  PLANNED: "planned",
};

export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? "muted"}>{STATE_LABEL[state] ?? state.replaceAll("_", " ").toLowerCase()}</Badge>;
}

/**
 * A task's status as a person should read it. A completed task that planned
 * no actions says so, instead of a green "completed" that implies work was done.
 */
export function TaskStatus({ state, noActions }: { state: string; noActions: boolean }) {
  if (state === "COMPLETED" && noActions) {
    return (
      <span title="The agent finished without proposing any action. Nothing was sent or changed.">
        <Badge>done · no actions taken</Badge>
      </span>
    );
  }
  return <StateBadge state={state} />;
}

export function When({ date }: { date: Date | string | null | undefined }) {
  if (!date) return <span className="text-muted">—</span>;
  const d = typeof date === "string" ? new Date(date) : date;
  return <time dateTime={d.toISOString()} title={d.toISOString()}>{d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</time>;
}

export const money = (cents: number | null | undefined, currency = "usd") =>
  cents === null || cents === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

/** Friendly CRM stage labels for SMB owners. */
export function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    appointmentscheduled: "Meeting scheduled",
    qualifiedtobuy: "Ready to buy",
    presentationscheduled: "Presentation set",
    decisionmakerboughtin: "Decision maker in",
    contractsent: "Contract sent",
    closedwon: "Won",
    closedlost: "Lost",
    prospect: "New lead",
    engaged: "In touch",
    qualified: "Qualified",
    opportunity: "Opportunity",
    disqualified: "Ruled out",
  };
  return map[stage.toLowerCase()] ?? stage.replaceAll("_", " ");
}
