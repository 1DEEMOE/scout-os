"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../../ui";

/** Shows a freshly issued booking link once, with copy. It can't be shown again: only its hash is stored. */
function NewLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/book/${token}`;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-accent/50 bg-accent/5 p-3 text-sm">
      <strong>Your booking link</strong>
      <code className="break-all rounded bg-line/40 px-2 py-1 text-xs">{url}</code>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={quietButtonCls} onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <a className="underline" href={url} target="_blank" rel="noreferrer">Open it</a>
      </div>
      <p className="text-muted">Save it now. For security it isn&apos;t stored, so it can&apos;t be shown again; you can always replace it with a new one.</p>
    </div>
  );
}

export function EnableDesk({ orgId, defaultName }: { orgId: string; defaultName: string }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (token) return <NewLink token={token} />;
  return (
    <form
      className="flex flex-col gap-3"
      action={async (f) => {
        setBusy(true);
        setError(null);
        try {
          const r = await trpc.gaps2.frontDeskEnable.mutate({
            orgId,
            displayName: String(f.get("displayName") ?? ""),
            timezone: String(f.get("timezone") ?? "") || undefined,
          });
          setToken(r.publicToken);
          router.refresh();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm">Name customers see
        <input name="displayName" required maxLength={120} defaultValue={defaultName} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Time zone
        <input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} maxLength={64} className={inputCls} />
      </label>
      <ErrorText message={error} />
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Creating…" : "Create booking link"}</button>
    </form>
  );
}

export function RotateLink({ orgId, channelId }: { orgId: string; channelId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (token) return <NewLink token={token} />;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className={`${quietButtonCls} self-start`}
        onClick={async () => {
          if (!window.confirm("Replace the booking link? The current link stops working immediately, wherever you've shared it.")) return;
          try {
            setToken((await trpc.gaps2.frontDeskRotateLink.mutate({ orgId, channelId })).publicToken);
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        Get a new link
      </button>
      <ErrorText message={error} />
    </div>
  );
}

/** Adds the same time slot on several days. Times are in the viewer's browser time zone. */
export function AddSlots({ orgId, channelId, deskTimezone }: { orgId: string; channelId: string; deskTimezone: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <form
      className="flex flex-col gap-3"
      action={async (f) => {
        setBusy(true);
        setError(null);
        setDone(null);
        try {
          const date = String(f.get("date"));
          const start = String(f.get("start"));
          const end = String(f.get("end"));
          const weeks = Math.max(1, Math.min(12, Number(f.get("weeks") ?? 1)));
          const capacity = Math.max(1, Math.min(50, Number(f.get("capacity") ?? 1)));
          const slots = Array.from({ length: weeks }, (_, i) => {
            const s = new Date(`${date}T${start}`);
            const e = new Date(`${date}T${end}`);
            s.setDate(s.getDate() + 7 * i);
            e.setDate(e.getDate() + 7 * i);
            return { startsAt: s.toISOString(), endsAt: e.toISOString(), capacity };
          });
          const r = await trpc.gaps2.frontDeskAddSlots.mutate({ orgId, channelId, slots });
          setDone(`Added ${r.added} slot${r.added === 1 ? "" : "s"}.`);
          router.refresh();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <label className="col-span-2 flex flex-col gap-1 text-sm sm:col-span-1">Date<input name="date" type="date" required className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm">From<input name="start" type="time" required defaultValue="09:00" className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm">To<input name="end" type="time" required defaultValue="10:00" className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm">People<input name="capacity" type="number" min={1} max={50} defaultValue={1} className={inputCls} /></label>
        <label className="flex flex-col gap-1 text-sm">Repeat weekly<select name="weeks" defaultValue="1" className={inputCls}>{[1, 2, 4, 8, 12].map((n) => <option key={n} value={n}>{n === 1 ? "No" : `${n} weeks`}</option>)}</select></label>
      </div>
      <p className="text-xs text-muted">
        Times are in your browser&apos;s time zone ({browserTz}).{browserTz !== deskTimezone && <> Customers see them in the desk&apos;s time zone ({deskTimezone}).</>}
      </p>
      <ErrorText message={error} />
      {done && <p role="status" className="text-sm text-accent">{done}</p>}
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Adding…" : "Add time slots"}</button>
    </form>
  );
}
