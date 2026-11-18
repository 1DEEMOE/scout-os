"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { ErrorText, inputCls, quietButtonCls } from "../../../../ui";

export interface LeadFormState {
  enabled: boolean;
  intro: string;
  successMessage: string;
  askPhone: boolean;
  askCompany: boolean;
  askMessage: boolean;
}

export function LeadFormCard({ orgId, channelId, initial }: { orgId: string; channelId: string; initial: LeadFormState }) {
  const router = useRouter();
  const [form, setForm] = useState<LeadFormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof LeadFormState>(key: K, value: LeadFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await trpc.crm.saveLeadForm.mutate({ orgId, channelId, form });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex items-center gap-3 text-base">
        <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Lead form is on
      </label>
      <p className="text-sm text-muted">
        The form lives at <code>/f/</code> + your booking link — same link as the booking page, with <code>f</code> instead of <code>book</code>.
        Every submission becomes a contact and an open deal on the sales board. Pausing the desk pauses the form too.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Intro line (optional)</span>
        <input className={inputCls} value={form.intro} onChange={(e) => set("intro", e.target.value)} maxLength={300} placeholder="Tell us what you need and we'll get back to you." />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Message after they send</span>
        <input className={inputCls} value={form.successMessage} onChange={(e) => set("successMessage", e.target.value)} maxLength={300} />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm text-muted">Also ask for</legend>
        <label className="flex items-center gap-3 text-base">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={form.askPhone} onChange={(e) => set("askPhone", e.target.checked)} />
          Phone number
        </label>
        <label className="flex items-center gap-3 text-base">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={form.askCompany} onChange={(e) => set("askCompany", e.target.checked)} />
          Company
        </label>
        <label className="flex items-center gap-3 text-base">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={form.askMessage} onChange={(e) => set("askMessage", e.target.checked)} />
          A message
        </label>
      </fieldset>
      <ErrorText message={error} />
      <div className="flex items-center gap-3">
        <button type="submit" className={quietButtonCls} disabled={busy}>
          Save lead form
        </button>
        {saved && <span className="text-sm text-muted">Saved.</span>}
      </div>
    </form>
  );
}
