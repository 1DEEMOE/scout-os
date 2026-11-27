"use client";
import { useState } from "react";
import { ErrorText, inputCls } from "../../ui";

/**
 * Posts to the public lead endpoint. The `website` field is a honeypot:
 * visually hidden off-screen and aria-hidden, so only bots filling every
 * field trip it (the server answers them with a fake success and stores
 * nothing).
 */
export function LeadForm({
  token,
  successMessage,
  askPhone,
  askCompany,
  askMessage,
  disclosure,
}: {
  token: string;
  successMessage: string;
  askPhone: boolean;
  askCompany: boolean;
  askMessage: boolean;
  disclosure: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/front-desk/${token}/lead`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, phone, company, message, website }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Something went wrong. Try again in a moment.");
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-raised)]">
        <h2 className="text-xl font-semibold">Message sent.</h2>
        <p className="mt-2 text-base text-muted">{successMessage}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Your name</span>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoComplete="name" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Email</span>
        <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required autoComplete="email" />
      </label>
      {askPhone && (
        <label className="flex flex-col gap-1">
          <span className="font-medium">Phone (optional)</span>
          <input className={inputCls} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="tel" />
        </label>
      )}
      {askCompany && (
        <label className="flex flex-col gap-1">
          <span className="font-medium">Company (optional)</span>
          <input className={inputCls} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} autoComplete="organization" />
        </label>
      )}
      {askMessage && (
        <label className="flex flex-col gap-1">
          <span className="font-medium">Message (optional)</span>
          <textarea className={inputCls} rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
        </label>
      )}
      <p className="text-sm text-muted">{disclosure}</p>
      <ErrorText message={error} />
      <div>
        <button
          type="submit"
          disabled={busy || !name.trim() || !email.trim()}
          className="accent-fill inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-base font-medium text-on-accent transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send message"}
        </button>
      </div>
    </form>
  );
}
