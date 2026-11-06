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
      className="text-sm text-muted hover:underline"
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
