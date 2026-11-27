"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls } from "../../../../ui";
import type { EliteCondition, EliteIntakeField } from "@wos/core";

type Answers = Record<string, string | number | boolean>;

/**
 * Client-side copy of the elite engine's condition matcher. Duplicated on
 * purpose: the engine lives in @wos/core with server-only dependencies, and
 * bundling it into a browser bundle is worse than 15 lines of duplicated
 * logic. The server re-validates everything on submit — this is UX only.
 */
function matches(c: EliteCondition | undefined, a: Answers): boolean {
  if (!c) return true;
  const v = a[c.field];
  switch (c.op) {
    case "eq": return v === c.value;
    case "ne": return v !== c.value;
    case "gt": return typeof v === "number" && typeof c.value === "number" && v > c.value;
    case "gte": return typeof v === "number" && typeof c.value === "number" && v >= c.value;
    case "in": return Array.isArray(c.value) && c.value.includes(String(v));
    case "truthy": return Boolean(v);
    default: return true;
  }
}

/**
 * The intake form renders itself from the industry pack: fields, order,
 * conditionals, and the phrasing a good dispatcher would use all come from
 * the pack, so a moving company and an HVAC shop get different forms with no
 * code fork.
 */
export function NewJobForm({ orgId, intake }: { orgId: string; intake: EliteIntakeField[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [answers, setAnswers] = useState<Answers>({});

  const visible = useMemo(() => intake.filter((f) => matches(f.showIf, answers)), [intake, answers]);

  function set(id: string, v: string | number | boolean | undefined) {
    setAnswers((a) => {
      const next = { ...a };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { jobId } = await trpc.jobs.create.mutate({
        orgId,
        customerName,
        customerEmail: customerEmail || undefined,
        customerPhone: customerPhone || undefined,
        answers,
      });
      router.push(`/orgs/${orgId}/jobs/${jobId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-semibold">Customer</legend>
        <label className="flex flex-col gap-1 text-base">
          Name
          <input className={inputCls} required maxLength={120} value={customerName} onChange={(e) => setCustomerName(e.target.value)} autoComplete="off" />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-base">
            Email <span className="text-sm text-muted">(needed to send the estimate)</span>
            <input className={inputCls} type="email" maxLength={200} value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 text-base">
            Phone <span className="text-sm text-muted">(optional)</span>
            <input className={inputCls} type="tel" maxLength={40} value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} autoComplete="off" />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-semibold">The job</legend>
        {visible.map((f) => (
          <label key={f.id} className="flex flex-col gap-1 text-base">
            <span>
              {f.label}
              {f.required && <span aria-hidden className="text-danger"> *</span>}
            </span>
            <span className="text-sm text-muted">{f.ask}</span>
            {f.type === "select" ? (
              <select
                className={inputCls}
                required={f.required}
                value={String(answers[f.id] ?? "")}
                onChange={(e) => set(f.id, e.target.value || undefined)}
              >
                <option value="">Choose…</option>
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : f.type === "boolean" ? (
              <span className="flex min-h-12 items-center gap-3">
                <input
                  type="checkbox"
                  className="h-6 w-6 accent-[var(--accent)]"
                  checked={Boolean(answers[f.id])}
                  onChange={(e) => set(f.id, e.target.checked)}
                />
                <span className="text-base">Yes</span>
              </span>
            ) : (
              <input
                className={inputCls}
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                inputMode={f.type === "number" ? "numeric" : undefined}
                required={f.required}
                min={f.min}
                max={f.max}
                maxLength={200}
                value={answers[f.id] === undefined ? "" : String(answers[f.id])}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") return set(f.id, undefined);
                  set(f.id, f.type === "number" ? Number(raw) : raw);
                }}
              />
            )}
          </label>
        ))}
      </fieldset>

      <ErrorText message={error} />
      <div className="sticky bottom-20 lg:bottom-4">
        <button type="submit" disabled={busy} className={`${buttonCls} w-full sm:w-auto`}>
          {busy ? "Saving…" : "Create job"}
        </button>
      </div>
    </form>
  );
}
