"use client";
import { useState } from "react";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, OwnerOnlyBadge, quietButtonCls, TierBadge } from "../../../../../ui";

const label = "flex flex-col gap-2 text-base font-medium";

/**
 * Scout drafts the first message from the evidence; a manager can edit it and
 * ask for an owner's OK. Nothing is sent from here.
 */
export function OutreachCard(props: { orgId: string; opportunityId: string; to: string | null; subject: string; body: string; canRequest: boolean; blockedReason: string | null; canAsk: boolean }) {
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <section aria-labelledby="outreach-title" className="flex flex-col gap-5 rounded-[var(--radius-card)] border border-line bg-surface p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="outreach-title" className="text-xl font-semibold">First message</h2>
        <span className="flex flex-wrap items-center gap-2"><TierBadge tier={2} /><OwnerOnlyBadge /></span>
      </div>
      <p className="text-muted">Scout wrote this from the storm evidence. Edit anything. It only goes out after an owner says OK, and the do-not-contact list is checked again right before sending.</p>
      {props.to && <p className="text-small"><span className="text-muted">To:</span> {props.to}</p>}
      <label className={label}>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={inputCls} /></label>
      <label className={label}>Message<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className={`${inputCls} leading-relaxed`} /></label>
      {!props.canRequest && props.blockedReason && (
        <p role="note" className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-3 text-small">{props.blockedReason}</p>
      )}
      <ErrorText message={error} />
      {asked ? (
        <p role="status" className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
          Waiting for an owner&apos;s OK. <a className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" href={`/orgs/${props.orgId}/approvals`}>Open approvals</a>
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {props.canRequest && props.canAsk && (
            <button
              type="button"
              disabled={busy}
              className={buttonCls}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await trpc.scout.requestOutreach.mutate({ orgId: props.orgId, opportunityId: props.opportunityId, subject, body });
                  setAsked(true);
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Asking…" : "Ask an owner to OK this"}
            </button>
          )}
          <button
            type="button"
            className={quietButtonCls}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${subject}\n\n${body}`);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy as a call script"}
          </button>
        </div>
      )}
    </section>
  );
}
