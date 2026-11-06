"use client";
import { useState } from "react";
import { buttonCls, ErrorText, inputCls } from "../../ui";

type Day = [string, { id: string; label: string; remaining: number }[]];

export function BookingForm({ token, days, disclosure, businessName }: { token: string; days: Day[]; disclosure: string; businessName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // One reference per page view, so a double-click or retry can't create two requests.
  const [clientRef] = useState(() => crypto.randomUUID());

  if (sent) {
    return (
      <div role="status" className="rounded-md border border-accent/50 bg-accent/5 p-4">
        <p className="font-medium">Request sent.</p>
        <p className="mt-1 text-sm text-muted">This isn&apos;t a confirmed appointment yet. {businessName} will review it and get back to you.</p>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      action={async (f) => {
        setBusy(true);
        setError(null);
        try {
          const res = await fetch(`/api/front-desk/${encodeURIComponent(token)}/bookings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              slotId: f.get("slotId"),
              requesterKind: "person",
              customerName: f.get("name"),
              customerEmail: f.get("email"),
              customerPhone: f.get("phone") || undefined,
              notes: f.get("notes") || undefined,
              disclosureAck: f.get("ack") === "on",
              clientRef,
            }),
          });
          if (res.ok) return setSent(true);
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(res.status === 409 ? "That time was just taken. Pick another one." : body.error ?? "That didn't go through. Try again.");
        } catch {
          setError("We couldn't reach the server. Check your connection and try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-medium">Pick a time</legend>
        {days.map(([day, slots]) => (
          <div key={day}>
            <p className="mb-2 text-sm text-muted">{day}</p>
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <label key={s.id} className="cursor-pointer rounded-md border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10">
                  <input type="radio" name="slotId" value={s.id} required className="sr-only" />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Your name<input name="name" required maxLength={200} autoComplete="name" className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm">Email<input name="email" type="email" required maxLength={254} autoComplete="email" className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm">Phone (optional)<input name="phone" type="tel" maxLength={40} autoComplete="tel" className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">Anything we should know? (optional)<textarea name="notes" rows={3} maxLength={2000} className={inputCls} /></label>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input name="ack" type="checkbox" required className="mt-1" />
        <span>{disclosure}</span>
      </label>
      <ErrorText message={error} />
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Sending…" : "Request this time"}</button>
    </form>
  );
}
