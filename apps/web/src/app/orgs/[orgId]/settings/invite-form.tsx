"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../ui";

export function InviteForm({ orgId, canGrantOwner }: { orgId: string; canGrantOwner: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(form: FormData) {
    setBusy(true);
    setError(null);
    setDone(null);
    setAcceptUrl(null);
    setCopied(false);
    const email = String(form.get("email") ?? "");
    try {
      const r = await trpc.org.invite.mutate({ orgId, email, role: String(form.get("role") ?? "member") });
      if (r.kind === "member") {
        setDone(`${email} added.`);
      } else {
        setDone(r.emailed ? `Invitation emailed to ${email}.` : `Invitation created for ${email}, but the email could not be sent — share this link with them directly.`);
        setAcceptUrl(r.acceptUrl);
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h2 className="font-semibold">Invite someone</h2>
      <p className="text-sm text-muted">If they already have an account they're added right away; otherwise they're emailed a sign-up link that expires in 7 days.</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input name="email" type="email" required placeholder="name@company.com" className={inputCls} />
        <select name="role" defaultValue="member" className={`${inputCls} sm:w-40`}>
          {canGrantOwner && <option value="owner">Owner</option>}
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="viewer">Viewer</option>
        </select>
      </div>
      <ErrorText message={error} />
      {done && <p className="text-sm text-accent">{done}</p>}
      {acceptUrl && (
        <div className="flex flex-col gap-2 rounded border border-line bg-line/20 p-3 text-xs">
          <span className="break-all font-mono">{acceptUrl}</span>
          <button
            type="button"
            className={`${quietButtonCls} self-start`}
            onClick={() => void navigator.clipboard.writeText(acceptUrl).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy invite link"}
          </button>
        </div>
      )}
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Working…" : "Invite"}</button>
    </form>
  );
}
