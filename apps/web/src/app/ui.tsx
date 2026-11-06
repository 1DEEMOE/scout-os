export const inputCls =
  "w-full rounded-lg border border-line bg-surface px-4 py-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
export const buttonCls =
  "rounded-lg bg-accent px-5 py-2.5 text-base font-medium text-on-accent disabled:opacity-50";
export const quietButtonCls =
  "rounded-lg border border-line bg-surface px-4 py-2.5 text-base hover:bg-line/40 disabled:opacity-50";
export const dangerButtonCls =
  "rounded-lg border border-danger/50 px-4 py-2.5 text-base text-danger hover:bg-danger/10 disabled:opacity-50";

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-base text-danger">
      {message}
    </p>
  );
}

const TIER_STYLE: Record<number, string> = {
  0: "border-line text-muted",
  1: "border-line text-muted",
  2: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  3: "border-orange-600/50 text-orange-700 dark:text-orange-300",
  4: "border-danger/60 text-danger",
};
const TIER_NAME = ["read-only", "internal", "external", "financial", "destructive"];

/** Plain-language risk label for list titles. Full tier stays in details. */
export function NeedOkBadge({ tier }: { tier: number }) {
  const label =
    tier >= 4 ? "Needs two people to OK" : tier >= 2 ? "Needs your OK" : "Low risk";
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-sm whitespace-nowrap ${TIER_STYLE[tier] ?? ""}`}>
      {label}
    </span>
  );
}

export function TierBadge({ tier }: { tier: number }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-sm whitespace-nowrap ${TIER_STYLE[tier] ?? ""}`}>
      Risk level {tier} · {TIER_NAME[tier]}
    </span>
  );
}

export function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" | "danger" | "warn" }) {
  const cls = {
    muted: "border-line text-muted",
    accent: "border-accent/50 text-accent",
    danger: "border-danger/50 text-danger",
    warn: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  }[tone];
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-sm whitespace-nowrap ${cls}`}>{children}</span>;
}

/** Everything produced by a fake provider or model is labelled, per project rules. */
export function MockBadge() {
  return <Badge tone="warn">MOCK</Badge>;
}

export function Card({ title, children, actions }: { title?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-sm">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-lg font-semibold tracking-tight">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line bg-paper/60 px-5 py-8">
      <p className="text-base text-muted">{children}</p>
      {action}
    </div>
  );
}

export function PageTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-3xl font-semibold tracking-tight">{children}</h1>
      {sub && <p className="mt-2 max-w-2xl text-base text-muted">{sub}</p>}
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
