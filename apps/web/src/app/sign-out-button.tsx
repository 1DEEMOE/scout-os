"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Ends the session server-side, then leaves the signed-in pages.
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-small text-ink transition-colors duration-150 hover:bg-soft disabled:opacity-60"
      onClick={async () => {
        setBusy(true);
        try {
          await authClient.signOut();
        } finally {
          window.location.href = "/sign-in";
        }
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
