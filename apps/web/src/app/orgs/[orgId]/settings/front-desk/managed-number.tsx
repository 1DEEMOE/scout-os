"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../../ui";
import type { ManagedNumberStatus, ProvisionProposal } from "@wos/core";

type Props = { orgId: string; isOwner: boolean; initial: ManagedNumberStatus };

/**
 * Managed business number: the platform buys and wires a Twilio number so the owner never
 * opens the Twilio console. Buying is a Tier 3 money action — the owner confirms in a dialog
 * that spells out the recurring cost and the booking-link rotation. Text-back stays off
 * until carrier registration (A2P) is recorded as approved.
 */
export function ManagedNumber({ orgId, isOwner, initial }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<ProvisionProposal | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  const rec = initial.record;

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (newToken) {
    const url = `${window.location.origin}/book/${newToken}`;
    return (
      <div role="status" className="flex flex-col gap-2 rounded-md border border-accent/50 bg-accent/5 p-3 text-sm">
        <strong>Your number is connected — and you have a new booking link</strong>
        <code className="break-all rounded bg-line/40 px-2 py-1 text-xs">{url}</code>
        <p className="text-muted">
          Getting a number issues a fresh booking link; the old one stopped working. Save this one now — it can&apos;t be shown again.
        </p>
        <button
          type="button"
          className={`${buttonCls} self-start`}
          onClick={() => {
            setNewToken(null);
            setProposal(null);
            router.refresh();
          }}
        >
          I&apos;ve saved this link
        </button>
      </div>
    );
  }

  if (!initial.enabled) {
    return <p className="text-sm text-muted">Managed phone numbers are not enabled on this platform yet. You can still forward your own number by hand.</p>;
  }

  if (!rec || rec.status === "released") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        {!proposal ? (
          <form
            className="flex flex-wrap items-end gap-2"
            action={async (f) => {
              const r = await run(() => trpc.gaps2.managedNumberPropose.mutate({ orgId, areaCode: String(f.get("areaCode") ?? "") }));
              if (r) setProposal(r);
            }}
          >
            <label className="flex flex-col gap-1">
              Your area code
              <input name="areaCode" required pattern="[2-9][0-9]{2}" maxLength={3} placeholder="314" className={`${inputCls} w-24`} />
            </label>
            <button disabled={busy} className={quietButtonCls}>{busy ? "Searching…" : "Find numbers"}</button>
            <ErrorText message={error} />
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {proposal.options.map((o) => (
                <li key={o.phone} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-3 py-2">
                  <span className="font-medium tabular-nums">{o.phone}</span>
                  {isOwner ? (
                    <button
                      type="button"
                      disabled={busy}
                      className={quietButtonCls}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `Get ${o.phone}?\n\n• It adds a recurring cost to the platform account.\n• Your booking link is replaced (the old one stops working).\n• Calls work right away; texting stays off until carrier registration is approved.`,
                          )
                        )
                          return;
                        const r = await run(() => trpc.gaps2.managedNumberProvision.mutate({ orgId, phone: o.phone }));
                        if (r?.publicToken) setNewToken(r.publicToken);
                        else if (r) router.refresh();
                      }}
                    >
                      {busy ? "Connecting…" : "Get this number"}
                    </button>
                  ) : (
                    <span className="text-xs text-muted">An owner can get a number</span>
                  )}
                </li>
              ))}
            </ul>
            <ul className="list-disc pl-5 text-xs text-muted">
              {proposal.warnings.map((w) => (
                <li key={w.slice(0, 32)}>{w}</li>
              ))}
            </ul>
            <ErrorText message={error} />
            <button type="button" className={`${quietButtonCls} self-start`} onClick={() => setProposal(null)}>Start over</button>
          </div>
        )}
      </div>
    );
  }

  const ready = initial.readiness;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <strong className="tabular-nums">{rec.phone}</strong>
        {ready.voice ? <span className="text-accent">Answering calls</span> : <span className="text-danger">Not answering</span>}
        {ready.textBack ? <span className="text-accent">· Text-back on</span> : <span className="text-muted">· Text-back off</span>}
        {rec.mock && <span className="rounded bg-line/60 px-1.5 py-0.5 text-xs">MOCK</span>}
      </p>
      {ready.reason && <p className="text-xs text-muted">{ready.reason}</p>}
      {isOwner && (
        <form
          className="flex flex-wrap items-center gap-2"
          action={async (f) => {
            const r = await run(() => trpc.gaps2.managedNumberA2p.mutate({ orgId, status: String(f.get("a2p")) as "not_started" | "pending" | "approved" | "rejected" }));
            if (r) router.refresh();
          }}
        >
          <label className="flex items-center gap-2 text-xs text-muted">
            Carrier registration (done with Twilio):
            <select name="a2p" defaultValue={rec.a2p} className={`${inputCls} w-36`}>
              <option value="not_started">Not started</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <button disabled={busy} className={quietButtonCls}>Save</button>
        </form>
      )}
      {isOwner && (
        <div>
          <button
            type="button"
            disabled={busy}
            className={`${quietButtonCls} text-danger`}
            onClick={async () => {
              if (!window.confirm(`Release ${rec.phone}? This is irreversible — the number is lost and callers reach nothing. Past calls and texts stay in the inbox.`)) return;
              const r = await run(() => trpc.gaps2.managedNumberRelease.mutate({ orgId }));
              if (r) router.refresh();
            }}
          >
            Release this number
          </button>
        </div>
      )}
      <ErrorText message={error} />
    </div>
  );
}
