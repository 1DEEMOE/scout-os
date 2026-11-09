"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls } from "../../../ui";

export function VisibilityCheck({ orgId, defaultTrade, defaultZip }: { orgId: string; defaultTrade: string; defaultZip: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-5 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
      action={async (f) => {
        setBusy(true);
        setError(null);
        try {
          await trpc.gaps2.aiAnswersRun.mutate({ orgId, trade: String(f.get("trade") ?? "").trim() || "roofing", zip: String(f.get("zip") ?? ""), force: true });
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-2 text-base font-medium">Trade<input name="trade" defaultValue={defaultTrade} maxLength={80} className={inputCls} /></label>
      <label className="flex flex-col gap-2 text-base font-medium">ZIP<input name="zip" defaultValue={defaultZip} required inputMode="numeric" maxLength={5} className={inputCls} /></label>
      <button type="submit" disabled={busy} className={buttonCls}>{busy ? "Checking…" : "Check now"}</button>
      <div className="sm:col-span-3"><ErrorText message={error} /></div>
    </form>
  );
}
