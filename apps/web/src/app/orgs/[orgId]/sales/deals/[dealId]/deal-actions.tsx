"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, Card, dangerButtonCls, ErrorText, inputCls, quietButtonCls, stageLabel } from "../../../../../ui";

const OPEN_FLOW = ["lead", "qualified", "quote_sent", "negotiation"] as const;
type OpenStage = (typeof OPEN_FLOW)[number];
const NEXT: Record<OpenStage, OpenStage | null> = { lead: "qualified", qualified: "quote_sent", quote_sent: "negotiation", negotiation: null };
const PREV: Record<OpenStage, OpenStage | null> = { lead: null, qualified: "lead", quote_sent: "qualified", negotiation: "quote_sent" };

interface DealShape {
  id: string;
  name: string;
  stage: string;
  amountCents: number | null;
  expectedClose: string | null;
  ownerUserId: string | null;
  lostReason: string | null;
}

export function DealActions({ orgId, role, deal, members }: { orgId: string; role: string; deal: DealShape; members: { userId: string; name: string }[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState(deal.lostReason ?? "");
  const [name, setName] = useState(deal.name);
  const [amount, setAmount] = useState(deal.amountCents === null ? "" : (deal.amountCents / 100).toString());
  const [expectedClose, setExpectedClose] = useState(deal.expectedClose ?? "");
  const [ownerUserId, setOwnerUserId] = useState(deal.ownerUserId ?? "");

  const isOpen = (OPEN_FLOW as readonly string[]).includes(deal.stage);
  const canWrite = role !== "viewer";
  const isManager = role === "owner" || role === "admin";

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const move = (stage: string, reason?: string | null) =>
    run(async () => {
      await trpc.crm.moveDeal.mutate({ orgId, dealId: deal.id, dealStage: stage as "lead", lostReason: reason ?? null });
    });

  if (!canWrite) {
    return (
      <Card title="Actions">
        <p className="text-sm text-muted">You have a view-only role in this workspace.</p>
      </Card>
    );
  }

  if (!isOpen) {
    return (
      <Card title="Outcome">
        <p className="text-base">This deal is {deal.stage}.</p>
        {deal.lostReason && <p className="mt-2 text-sm text-muted">Reason: {deal.lostReason}</p>}
        {isManager ? (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-sm text-muted">Reopen it to an open stage:</p>
            <div className="flex flex-wrap gap-2">
              {OPEN_FLOW.map((s) => (
                <button key={s} type="button" className={quietButtonCls} disabled={busy} onClick={() => move(s)}>
                  Reopen as {stageLabel(s)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted">Only an owner or admin can reopen a closed deal.</p>
        )}
        <ErrorText message={error} />
      </Card>
    );
  }

  const stage = deal.stage as OpenStage;
  const next = NEXT[stage];
  const prev = PREV[stage];

  return (
    <div className="flex flex-col gap-6">
      <Card title="Move this deal">
        <div className="flex flex-wrap gap-2">
          {prev && (
            <button type="button" className={quietButtonCls} disabled={busy} onClick={() => move(prev)}>
              ← {stageLabel(prev)}
            </button>
          )}
          {next && (
            <button type="button" className={buttonCls} disabled={busy} onClick={() => move(next)}>
              {stageLabel(next)} →
            </button>
          )}
          <button
            type="button"
            className={buttonCls}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Mark "${deal.name}" as won?`)) move("won");
            }}
          >
            Mark won
          </button>
          {!losing ? (
            <button type="button" className={dangerButtonCls} disabled={busy} onClick={() => setLosing(true)}>
              Mark lost
            </button>
          ) : (
            <div className="flex w-full flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-muted">Why was it lost? (optional)</span>
                <input className={inputCls} value={lostReason} onChange={(e) => setLostReason(e.target.value)} maxLength={200} placeholder="e.g. Went with a competitor" />
              </label>
              <div className="flex gap-2">
                <button type="button" className={dangerButtonCls} disabled={busy} onClick={() => move("lost", lostReason || null)}>
                  Confirm lost
                </button>
                <button type="button" className={quietButtonCls} disabled={busy} onClick={() => setLosing(false)}>
                  Keep open
                </button>
              </div>
            </div>
          )}
        </div>
        <ErrorText message={error} />
      </Card>

      <Card title="Edit">
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = amount.trim() ? Math.round(Number(amount) * 100) : null;
            if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
              setError("Amount must be a positive number.");
              return;
            }
            run(async () => {
              await trpc.crm.updateDeal.mutate({
                orgId,
                dealId: deal.id,
                name,
                amountCents: parsed,
                expectedClose: expectedClose || null,
                ownerUserId: ownerUserId || null,
              });
            });
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted">Name</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted">Amount ($)</span>
            <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted">Expected close</span>
            <input className={inputCls} type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted">Owner</span>
            <select className={inputCls} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={quietButtonCls} disabled={busy || !name.trim()}>
              Save changes
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
