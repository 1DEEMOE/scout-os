"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { authClient } from "@/lib/auth-client";
import { BRAND } from "@/brand";
import { buttonCls, ErrorText, inputCls } from "./ui";

function safeNext(next: string | null): string | null {
  // Only same-site paths: an absolute URL here would be an open redirect.
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

function Form({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(form: FormData) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const res =
      mode === "sign-up"
        ? await authClient.signUp.email({ email, password, name: String(form.get("name") ?? "") })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That didn't work. Check your details and try again.");
      return;
    }
    if (mode === "sign-up") setNotice("Account created. If we sent you a verification email, please click its link.");
    router.push(next ?? "/orgs");
    router.refresh();
  }

  return (
    <form action={onSubmit} className="mx-auto flex max-w-sm flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{mode === "sign-up" ? `Create your ${BRAND.name} account` : `Sign in to ${BRAND.name}`}</h1>
        <p className="mt-1 text-sm text-muted">{BRAND.tagline}</p>
      </div>
      {mode === "sign-up" && (
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input name="name" required autoComplete="name" className={inputCls} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" type="email" required autoComplete="email" className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          className={inputCls}
        />
        {mode === "sign-up" && <span className="text-xs text-muted">At least 12 characters.</span>}
      </label>
      <ErrorText message={error} />
      {notice && <p role="status" className="text-sm text-accent">{notice}</p>}
      <button disabled={busy} className={buttonCls}>
        {busy ? "Working…" : mode === "sign-up" ? "Create account" : "Sign in"}
      </button>
      <p className="text-sm text-muted">
        {mode === "sign-up" ? (
          <>Have an account? <a className="underline" href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}>Sign in</a></>
        ) : (
          <>New here? <a className="underline" href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"}>Create an account</a></>
        )}
      </p>
      {mode === "sign-in" && (
        <p className="text-sm text-muted"><a className="underline" href="/forgot-password">Forgot your password?</a></p>
      )}
    </form>
  );
}

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  return (
    <Suspense>
      <Form mode={mode} />
    </Suspense>
  );
}
