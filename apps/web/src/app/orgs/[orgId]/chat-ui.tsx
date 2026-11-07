import type { ApprovalForReview } from "@wos/core";
import { ActionButton } from "../../actions";
import { fieldList } from "../../field-labels";
import { MockBadge, NeedOkBadge, TIER_RAIL, When } from "../../ui";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Scout's small mark beside its messages (original geometry; no third-party assets). */
function ScoutGlyph() {
  return (
    <span aria-hidden className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
        <path d="M10 2.5 12.2 10 10 17.5 7.8 10Z" />
      </svg>
    </span>
  );
}

/**
 * A message from Scout. Not boxed: it reads like a calm note under a small
 * mark. Structured content (briefings, approvals) goes in `children`.
 */
export function ScoutMessage({ title, children, at, mock, id }: { title?: React.ReactNode; children?: React.ReactNode; at?: Date | string | null; mock?: boolean; id?: string }) {
  return (
    <li id={id} className="motion-rise flex gap-3.5">
      <ScoutGlyph />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="font-medium text-ink">Scout</span>
          {mock && <MockBadge />}
          {at && <When date={at} />}
        </div>
        {title && <p className="text-message leading-relaxed">{title}</p>}
        {children && <div className={title ? "mt-4" : ""}>{children}</div>}
      </div>
    </li>
  );
}

/** A message from a person: a soft pill on the right. */
export function PersonMessage({ name, at, children }: { name: string; at?: Date | string | null; children: React.ReactNode }) {
  return (
    <li className="motion-rise flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="font-medium text-ink">{name}</span>
        {at && <When date={at} />}
      </div>
      <div className="max-w-[min(36rem,92%)] rounded-[1.25rem] rounded-tr-md bg-soft px-4 py-3 text-message leading-relaxed break-words whitespace-pre-wrap">
        {children}
      </div>
    </li>
  );
}

export function Transcript({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-col gap-9">
      {children}
    </ol>
  );
}

/**
 * An approval, inline in the conversation. The coloured rail shows the risk
 * tier. Buttons call the same approval.decide / approval.confirm procedures as
 * the Approvals page; the server still enforces every tier rule (second
 * confirmation by a different person at tier 4, no self-approval, expiry).
 */
export function ApprovalCard({ item, orgId }: { item: ApprovalForReview; orgId: string }) {
  const a = item.approval;
  const r = item.reviewer;
  return (
    <article aria-label={`Approval: ${item.headline}`} className="relative overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-raised)]">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${TIER_RAIL[a.tier] ?? "bg-line"}`} />
      <div className="flex flex-col gap-4 py-5 pr-5 pl-6 sm:pr-6 sm:pl-7">
        <div className="flex flex-wrap items-center gap-2">
          <NeedOkBadge tier={a.tier} />
          <span className="text-sm text-muted">asked by {item.requestedByName}</span>
        </div>
        <p className="text-lg leading-snug font-medium">{item.headline}</p>
        {item.context.length > 0 && (
          <dl className="grid gap-x-4 gap-y-1.5 text-small sm:grid-cols-[9rem_1fr]">
            {item.context.slice(0, 4).map((l, i) => (
              <div key={`${l.label}-${i}`} className="contents">
                <dt className="text-muted">{l.label}</dt>
                <dd className="break-words">{l.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {item.externalDataFields.length > 0 && (
          <p className="rounded-xl border border-warn/40 bg-warn/5 px-3 py-2 text-small">
            <strong>Check the details.</strong> {capitalize(fieldList(item.externalDataFields))} came from an email or message that anyone could write, so make sure {item.externalDataFields.length === 1 ? "it looks" : "they look"} right.
          </p>
        )}
        <details className="text-small">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted hover:text-ink">Exact action and expiry</summary>
          <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr]">
            <dt className="text-muted">Task</dt>
            <dd><a className="inline-flex min-h-6 items-center underline decoration-line underline-offset-4 hover:decoration-accent" href={`/orgs/${orgId}/tasks/${item.taskId}`}>{item.taskTitle}</a></dd>
            <dt className="text-muted">Risk level</dt>
            <dd>{a.tier}</dd>
            <dt className="text-muted">Expires</dt>
            <dd><When date={a.expiresAt} /></dd>
          </dl>
        </details>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {r.kind === "can_approve" && (
            <>
              <ActionButton path="approval.decide" input={{ orgId, approvalId: a.id, decision: "approve" }} label={a.tier === 4 ? "Approve once (needs a second owner)" : "Approve once"} variant="primary" />
              <ActionButton path="approval.decide" input={{ orgId, approvalId: a.id, decision: "reject" }} label="Not now" />
            </>
          )}
          {r.kind === "can_confirm" && (
            <ActionButton path="approval.confirm" input={{ orgId, approvalId: a.id }} label="Confirm and run" variant="danger" confirm="This cannot be undone. Confirm?" />
          )}
          {r.kind === "read_only" && r.reason && <p className="text-small text-muted">{r.reason}</p>}
          <a href={`/orgs/${orgId}/approvals`} className="ml-auto inline-flex min-h-11 items-center text-small text-muted underline hover:text-ink">All approvals</a>
        </div>
      </div>
    </article>
  );
}

/** Soft container for structured content inside a Scout message. */
export function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5 sm:p-6">{children}</div>;
}
