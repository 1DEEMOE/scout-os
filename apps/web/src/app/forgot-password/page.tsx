"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { buttonCls, ErrorText, inputCls } from "../ui";

export default function ForgotPasswordPage() {
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
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      {sent ? (
        <p role="status" className="text-sm text-accent">If that email has an account, a reset link is on its way. The link expires in 1 hour.</p>
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
