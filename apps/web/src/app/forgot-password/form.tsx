"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { buttonCls, ErrorText, inputCls } from "../ui";

export function ForgotPasswordForm({ emailConfigured }: { emailConfigured: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(form: FormData) {
    setBusy(true);
    setError(null);
    // The server answers the same way whether or not the email has an account,
    // so this page can't be used to probe for registered addresses.
    const res = await authClient.requestPasswordReset({
      email: String(form.get("email") ?? ""),
      redirectTo: "/reset-password",
    });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That didn't work. Try again.");
      return;
    }
    setSent(true);
  }

  return (
    <form action={onSubmit} className="mx-auto flex max-w-sm flex-col gap-4">
      <h1 className="text-display font-semibold">Reset your password</h1>
      {!emailConfigured && (
        <p role="note" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          Email isn&apos;t set up on this server yet, so reset links can&apos;t be delivered. Ask whoever runs this Scout OS install to reset it for you.
        </p>
      )}
      {sent ? (
        <p role="status" className="text-sm text-accent">
          {emailConfigured
            ? "If that email has an account, a reset link is on its way. The link expires in 1 hour."
            : "Request recorded, but email isn't set up on this server, so no link was sent."}
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input name="email" type="email" required autoComplete="email" className={inputCls} />
          </label>
          <ErrorText message={error} />
          <button disabled={busy} className={buttonCls}>{busy ? "Sending…" : "Email me a reset link"}</button>
        </>
      )}
      <p className="text-sm text-muted"><a className="underline" href="/sign-in">Back to sign in</a></p>
    </form>
  );
}
