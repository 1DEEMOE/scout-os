"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, TierBadge } from "../../../ui";

const label = "flex flex-col gap-2 text-base font-medium";
const FLAG_TEXT: Record<string, string> = {
  bank_mismatch: "bank details don't match what's on file",
  domain_mismatch: "sent from a different email domain than usual",
  duplicate_number: "same number as an earlier document",
  unknown_bank: "bank details aren't on file for this vendor",
  amount_outlier: "amount is far outside this vendor's usual range",
  pdf_metadata_altered: "the PDF looks edited after it was created",
};

/** Check an incoming invoice before anyone pays it. Suspicious ones are held for an owner; nothing is paid automatically. */
export function InvoiceCheck({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ flags: string[]; held: boolean; tier: number } | null>(null);

  async function submit(f: FormData) {
    setBusy(true);
    setError(null);
    setResult(null);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const vendorEmail = str("vendorEmail");
    const expected = str("expectedDomain").replace(/^@/, "");
    const last4 = str("accountLast4");
    try {
      const r = await trpc.gaps2.documentAnalyze.mutate({
        orgId,
        documentKind: str("kind") === "estimate" ? "estimate" : "invoice",
        vendorName: str("vendorName"),
        ...(vendorEmail ? { vendorEmail, senderDomain: vendorEmail.split("@")[1] ?? "" } : {}),
        ...(expected ? { expectedDomain: expected } : {}),
        ...(str("documentNumber") ? { documentNumber: str("documentNumber") } : {}),
        amountCents: Math.round(Number(str("amount").replace(/[$,]/g, "")) * 100) || 0,
        ...(/^\d{4}$/.test(last4) ? { accountLast4: last4 } : {}),
      });
      const out = r as { riskFlags: string[]; approvalRequestId: string | null };
      setResult({ flags: out.riskFlags, held: !!out.approvalRequestId, tier: 3 });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={submit} className="grid gap-5 sm:grid-cols-2">
        <label className={label}>
          Type
          <select name="kind" defaultValue="invoice" className={inputCls}>
            <option value="invoice">Invoice</option>
            <option value="estimate">Estimate</option>
          </select>
        </label>
        <label className={label}>Vendor<input name="vendorName" required maxLength={200} className={inputCls} /></label>
        <label className={label}>Sent from (email)<input name="vendorEmail" type="email" maxLength={200} className={inputCls} /></label>
        <label className={label}>Their usual domain <span className="font-normal text-muted">(optional)</span><input name="expectedDomain" maxLength={200} placeholder="acme.com" className={inputCls} /></label>
        <label className={label}>Number<input name="documentNumber" maxLength={80} className={inputCls} /></label>
        <label className={label}>Amount ($)<input name="amount" inputMode="decimal" required className={inputCls} /></label>
        <label className={label}>Bank account, last 4 digits <span className="font-normal text-muted">(optional)</span><input name="accountLast4" inputMode="numeric" maxLength={4} className={inputCls} /></label>
        <div className="flex items-end">
          <button type="submit" disabled={busy} className={buttonCls}>{busy ? "Checking…" : "Check this invoice"}</button>
        </div>
      </form>
      <ErrorText message={error} />
      {result && (
        <div role="status" className={`flex flex-col gap-3 rounded-2xl border px-5 py-4 ${result.held ? "border-caution/40 bg-caution/5" : "border-line bg-surface"}`}>
          {result.held ? (
            <>
              <p className="flex flex-wrap items-center gap-2 font-medium">Held for an owner&apos;s OK <TierBadge tier={result.tier} /></p>
              <ul className="list-disc space-y-1 pl-5 text-small">
                {result.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f.replace(/_/g, " ")}</li>)}
              </ul>
              <p className="text-small text-muted">Nothing is paid automatically. An owner decides on the Approvals page.</p>
            </>
          ) : (
            <p>No red flags found. It still isn&apos;t paid automatically.</p>
          )}
        </div>
      )}
    </div>
  );
}
