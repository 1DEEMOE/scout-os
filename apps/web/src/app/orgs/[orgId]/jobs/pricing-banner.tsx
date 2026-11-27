"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls } from "../../../ui";

type Field = { id: string; label: string; filled: boolean };

/**
 * Two launch gates for estimates, in one place:
 * 1. Prices start as pack EXAMPLES — sending is blocked until the owner confirms them as real.
 * 2. The pack's compliance demands business details (e.g. USDOT) before a document goes out.
 * Both are deliberate: an estimate with pretend prices or missing license data should fail closed.
 */
export function JobsPricingBanner({ orgId, isOwner, priceBasis, fields }: { orgId: string; isOwner: boolean; priceBasis: "example" | "owner_configured"; fields: Field[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = fields.filter((f) => !f.filled);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (priceBasis === "owner_configured" && missing.length === 0) return null;

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-warn/40 bg-warn/5 px-5 py-4">
      {priceBasis === "example" && (
        <div className="flex flex-col gap-2">
          <strong>Estimates use example prices.</strong>
          <p className="text-base">
            Every figure comes from the industry pack as a starting point. Sending stays blocked until the owner confirms the prices are real.
          </p>
          {isOwner ? (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => trpc.jobs.confirmPricing.mutate({ orgId }))}
                className={buttonCls}
              >
                I&apos;ve reviewed these prices — they&apos;re mine
              </button>
            </div>
          ) : (
            <p className="text-base text-muted">Only the owner can confirm prices.</p>
          )}
        </div>
      )}
      {missing.length > 0 && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fieldsToSave = Object.fromEntries(missing.map((f) => [f.id, values[f.id] ?? ""] as const).filter(([, v]) => v.trim()));
            if (Object.keys(fieldsToSave).length) void run(() => trpc.jobs.saveBusinessFields.mutate({ orgId, fields: fieldsToSave }));
          }}
        >
          <strong>Needed before an estimate can go out:</strong>
          {missing.map((f) => (
            <label key={f.id} className="flex flex-col gap-1 text-base">
              {f.label}
              <input
                className={inputCls}
                value={values[f.id] ?? ""}
                maxLength={120}
                onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
              />
            </label>
          ))}
          <div>
            <button type="submit" disabled={busy} className={buttonCls}>Save business details</button>
          </div>
        </form>
      )}
      <ErrorText message={error} />
    </div>
  );
}
