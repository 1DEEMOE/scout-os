"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function NewRoutineForm({ orgId, defaultTz }: { orgId: string; defaultTz: string }) {
  const router = useRouter();
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : defaultTz;
  return (
    <form
      className="flex flex-col gap-3"
      action={async (f: FormData) => {
        setBusy(true);
        setError(null);
        try {
          const [h, m] = String(f.get("time") ?? "07:00").split(":");
          await trpc.routines.create.mutate({ orgId, kind: "morning_briefing", name: String(f.get("name") ?? ""), hour: Number(h), minute: Number(m), daysOfWeek: days, timezone: String(f.get("timezone") ?? "") });
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" className={inputCls} defaultValue="Morning briefing" maxLength={120} required />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Time
          <input name="time" type="time" className={inputCls} defaultValue="07:00" required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Time zone (IANA)
          <input name="timezone" className={inputCls} defaultValue={browserTz || defaultTz} maxLength={64} required />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-2 text-sm">
        <legend className="mb-1">Days</legend>
        {DAYS.map((d, i) => (
          <label key={d} className={`${quietButtonCls} cursor-pointer ${days.includes(i) ? "border-accent font-medium" : ""}`}>
            <input type="checkbox" className="mr-1" checked={days.includes(i)} onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, i] : cur.filter((x) => x !== i)).sort())} />
            {d}
          </label>
        ))}
      </fieldset>
      <ErrorText message={error} />
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Working…" : "Create routine"}</button>
    </form>
  );
}

export function RunNowButton({ orgId, routineId, disabled }: { orgId: string; routineId: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1 self-start">
      <button
        type="button"
        className={quietButtonCls}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await trpc.routines.runNow.mutate({ orgId, routineId, clientRef: crypto.randomUUID().replace(/-/g, "") });
            setMsg("Queued. The briefing appears here when the worker finishes it.");
            router.refresh();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Queuing…" : "Run now"}
      </button>
      {msg && <span className="text-xs text-muted">{msg}</span>}
      <ErrorText message={error} />
    </span>
  );
}
