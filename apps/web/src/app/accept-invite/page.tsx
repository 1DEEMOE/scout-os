"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText } from "../ui";

function AcceptInvite() {
  const router = useRouter();
  const params = useSearchParams();
  const org = params.get("org") ?? "";
  const token = params.get("token") ?? "";
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!org || !token) {
    return <p role="alert" className="text-sm text-danger">This invitation link is incomplete. Ask for a fresh one.</p>;
  }
  if (isPending) return <p className="text-sm text-muted">Loading…</p>;

  if (!session) {
    // Sign up (or in) with the invited address, then return to this link.
    const back = encodeURIComponent(`/accept-invite?org=${org}&token=${encodeURIComponent(token)}`);
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">You need an account to accept this invitation. Sign up with the email address the invitation was sent to — then come back to this link.</p>
        <p className="flex gap-4 text-sm">
          <a className="underline" href={`/sign-up?next=${back}`}>Create an account</a>
          <a className="underline" href={`/sign-in?next=${back}`}>Sign in</a>
        </p>
      </div>
    );
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await trpc.org.acceptInvitation.mutate({ orgId: org, token });
      router.push(`/orgs/${r.orgId}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">Signed in as <strong>{session.user.email}</strong>. Accept the invitation to join the organization?</p>
      <ErrorText message={error} />
      <button className={`${buttonCls} self-start`} disabled={busy} onClick={() => void accept()}>
        {busy ? "Joining…" : "Accept invitation"}
      </button>
      <p className="text-xs text-muted">The invitation only works for the email address it was sent to.</p>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold">You're invited</h1>
      <Suspense>
        <AcceptInvite />
      </Suspense>
    </div>
  );
}
