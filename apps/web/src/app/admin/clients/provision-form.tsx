"use client";
import { useEffect, useState } from "react";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../ui";

const label = "flex flex-col gap-2 text-base font-medium";

export function ProvisionForm({ packs }: { packs: { id: string; label: string; group: string }[] }) {
  const [timezone, setTimezone] = useState("America/New_York");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; email: string; url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) setTimezone(tz);
  }, []);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    const name = String(form.get("name") ?? "");
    const clientEmail = String(form.get("clientEmail") ?? "");
    const zip = String(form.get("zip") ?? "").trim();
    try {
      const r = await trpc.onboarding.provisionWorkspace.mutate({
        name,
        industry: String(form.get("industry") ?? "roofing"),
        clientEmail,
        confirmEmail: String(form.get("confirmEmail") ?? ""),
        ...(zip ? { zip } : {}),
        timezone: String(form.get("timezone") ?? timezone),
      });
      setMade({ name, email: clientEmail, url: r.inviteUrl, expiresAt: r.expiresAt });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    return (
      <section aria-label="Workspace ready" className="flex flex-col gap-5 rounded-[var(--radius-card)] border border-line bg-surface p-7">
        <h2 className="text-xl font-semibold">{made.name} is ready</h2>
        <p className="text-muted">Send this link to {made.email}. It&apos;s shown only now.</p>
        <label className={label}>
          Invite link
          <input readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono text-sm`} />
        </label>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonCls}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(made.url);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button type="button" className={quietButtonCls} onClick={() => { setMade(null); setCopied(false); }}>
            Create another
          </button>
        </div>
        <p role="status" className="text-sm text-muted">Expires {new Date(made.expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}.</p>
      </section>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-6">
      <label className={label}>
        Business name
        <input name="name" required maxLength={120} placeholder="Peachtree Roofing" className={inputCls} />
      </label>
      <label className={label}>
        Trade
        <select name="industry" defaultValue="roofing" className={inputCls}>
          {packs.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label className={label}>
        Service-area ZIP <span className="font-normal text-muted">(optional, pre-fills their setup)</span>
        <input name="zip" inputMode="numeric" maxLength={10} placeholder="30303" className={inputCls} />
      </label>
      <label className={label}>
        Client&apos;s email
        <input name="clientEmail" type="email" required autoComplete="off" className={inputCls} />
      </label>
      <label className={label}>
        Type it again to confirm
        <input name="confirmEmail" type="email" required autoComplete="off" aria-describedby="confirm-note" className={inputCls} />
      </label>
      <p id="confirm-note" className="-mt-4 text-sm text-muted">They&apos;ll be the owner, so we check the address twice.</p>
      <input type="hidden" name="timezone" value={timezone} />
      <ErrorText message={error} />
      <button type="submit" disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Creating…" : "Create workspace and link"}</button>
    </form>
  );
}
