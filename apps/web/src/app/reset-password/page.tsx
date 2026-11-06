"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { buttonCls, ErrorText, inputCls } from "../ui";

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(form: FormData) {
    setBusy(true);
    setError(null);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setBusy(false);
      setError("The passwords don't match.");
      return;
    }
    const res = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That link didn't work. Request a fresh one.");
      return;
    }
    router.push("/sign-in");
    router.refresh();
  }

  if (!token) {
    return <p role="alert" className="text-sm text-danger">This reset link is missing its token. Request a fresh one from the <a className="underline" href="/forgot-password">reset page</a>.</p>;
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        New password
        <input name="password" type="password" required minLength={12} autoComplete="new-password" className={inputCls} />
        <span className="text-xs text-muted">At least 12 characters.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Repeat it
        <input name="confirm" type="password" required minLength={12} autoComplete="new-password" className={inputCls} />
      </label>
      <ErrorText message={error} />
      <button disabled={busy} className={buttonCls}>{busy ? "Saving…" : "Set new password"}</button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      <Suspense>
        <ResetForm />
      </Suspense>
    </div>
  );
}
