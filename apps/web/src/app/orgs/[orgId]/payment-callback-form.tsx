"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText } from "../../ui";

/** Record a call-back on the number already on file — never trust a number from the request. */
export function PaymentCallbackForm({
  orgId,
  changeId,
  onFilePhoneHint,
}: {
  orgId: string;
  changeId: string;
  onFilePhoneHint: string | null;
}) {
  const router = useRouter();
  const [calledNumber, setCalledNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await trpc.finance.recordPaymentCallback.mutate({
        orgId,
        changeId,
        calledNumber,
        notes: notes.trim() || undefined,
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-base text-muted">
        Call the number on file{onFilePhoneHint ? ` (${onFilePhoneHint})` : ""}, then type that same number below. Do not use a number from the change request.
      </p>
      <label className="flex flex-col gap-1.5 text-base">
        <span className="font-medium">Number you called</span>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          value={calledNumber}
          onChange={(e) => setCalledNumber(e.target.value)}
          className="rounded-lg border border-line bg-surface px-3 py-3 text-base"
          placeholder="e.g. 5551234567"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-base">
        <span className="font-medium">Notes (optional)</span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          className="rounded-lg border border-line bg-surface px-3 py-3 text-base"
          placeholder="Who you spoke with"
        />
      </label>
      <button type="submit" disabled={busy} className={buttonCls}>
        {busy ? "Saving…" : "Record call-back"}
      </button>
      <ErrorText message={error} />
    </form>
  );
}
