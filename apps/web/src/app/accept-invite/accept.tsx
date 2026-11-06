"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../ui";

const label = "flex flex-col gap-2 text-base font-medium";

export function AcceptInvite({ google }: { google: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const org = params.get("org") ?? "";
  const token = params.get("token") ?? "";
  const invited = (params.get("email") ?? "").trim().toLowerCase();
  const workspace = (params.get("ws") ?? "").trim().slice(0, 120);
  const zip = (params.get("zip") ?? "").replace(/\D/g, "").slice(0, 5);
  const { data: session, isPending } = authClient.useSession();
  const [mode, setMode] = useState<"create" | "sign-in">("create");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accepting = useRef(false);

  const welcome = (orgId: string) => `/orgs/${orgId}/welcome${zip ? `?zip=${zip}` : ""}`;

  async function accept() {
    if (accepting.current) return;
    accepting.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await trpc.org.acceptInvitation.mutate({ orgId: org, token });
      router.push(welcome(r.orgId));
    } catch (err) {
      const msg = errorMessage(err);
      // Clicking the link twice is fine: you're already in.
      if (/already a member/i.test(msg)) router.push(welcome(org));
      else {
        setError(msg);
        accepting.current = false;
        setBusy(false);
      }
    }
  }

  const signedInEmail = session?.user.email.toLowerCase();
  const mismatch = !!session && !!invited && signedInEmail !== invited;
  // Opening your own link while signed in takes you straight in.
  useEffect(() => {
    if (session && !mismatch && org && token) void accept();
  }, [session, mismatch, org, token]);

  if (!org || !token) {
    return <p role="alert" className="text-danger">This invitation link is incomplete. Ask whoever sent it for a fresh one.</p>;
  }

  const heading = (
    <div>
      <p className="text-muted">You&apos;re invited to</p>
      <h1 className="mt-1 text-display font-semibold">{workspace || "your Scout OS workspace"}</h1>
    </div>
  );

  if (isPending) return heading;

  if (session && mismatch) {
    return (
      <>
        {heading}
        <p>
          You&apos;re signed in as <strong>{session.user.email}</strong>, but this invitation is for <strong>{invited}</strong>.
        </p>
        <button
          type="button"
          className={`${quietButtonCls} self-start`}
          onClick={async () => {
            await authClient.signOut();
            router.refresh();
          }}
        >
          Sign out and continue as {invited}
        </button>
      </>
    );
  }

  if (session) {
    return (
      <>
        {heading}
        <p role="status" className="text-muted">{busy ? "Opening your workspace…" : "Ready."}</p>
        <ErrorText message={error} />
        {error && <button type="button" className={`${buttonCls} self-start`} onClick={() => void accept()}>Try again</button>}
      </>
    );
  }

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    const email = (invited || String(form.get("email") ?? "")).trim();
    const password = String(form.get("password") ?? "");
    const res =
      mode === "create"
        ? await authClient.signUp.email({ email, password, name: String(form.get("name") ?? "").trim() || email.split("@")[0]! })
        : await authClient.signIn.email({ email, password });
    if (res.error) {
      setBusy(false);
      if (mode === "create" && /exist/i.test(res.error.message ?? "")) {
        setMode("sign-in");
        setError("You already have an account with that email. Enter its password to continue.");
        return;
      }
      setError(res.error.message ?? "That didn't work. Check your details and try again.");
      return;
    }
    await accept();
  }

  return (
    <>
      {heading}
      <p className="text-lg text-muted">
        {mode === "create" ? "Set a password and you're in. It takes under a minute." : "Sign in to open your workspace."}
      </p>
      {google && (
        <>
          <button
            type="button"
            className={`${quietButtonCls} w-full`}
            onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: window.location.href })}
          >
            Continue with Google
          </button>
          <p aria-hidden className="text-center text-sm text-muted">or</p>
        </>
      )}
      <form action={submit} className="flex flex-col gap-5">
        {mode === "create" && (
          <label className={label}>
            Your name
            <input name="name" autoComplete="name" className={inputCls} />
          </label>
        )}
        <label className={label}>
          Email
          {invited ? (
            <input name="email" type="email" value={invited} readOnly autoComplete="email" aria-describedby="email-note" className={`${inputCls} bg-soft`} />
          ) : (
            <input name="email" type="email" required autoComplete="email" className={inputCls} />
          )}
        </label>
        {invited && <p id="email-note" className="-mt-3 text-sm text-muted">The invitation works only for this address.</p>}
        <label className={label}>
          {mode === "create" ? "Create a password" : "Password"}
          <input name="password" type="password" required minLength={mode === "create" ? 12 : 1} autoComplete={mode === "create" ? "new-password" : "current-password"} aria-describedby="pw-note" className={inputCls} />
        </label>
        {mode === "create" && <p id="pw-note" className="-mt-3 text-sm text-muted">At least 12 characters.</p>}
        <ErrorText message={error} />
        <button type="submit" disabled={busy} className={`${buttonCls} w-full`}>
          {busy ? "Opening your workspace…" : "Open my workspace"}
        </button>
      </form>
      <button type="button" className="inline-flex min-h-11 items-center self-center text-base text-accent underline underline-offset-4" onClick={() => { setMode(mode === "create" ? "sign-in" : "create"); setError(null); }}>
        {mode === "create" ? "I already have an account" : "I need to create a password"}
      </button>
    </>
  );
}
