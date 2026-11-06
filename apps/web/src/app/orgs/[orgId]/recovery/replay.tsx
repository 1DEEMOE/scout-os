"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls } from "../../../ui";

export function ReplayButton({ orgId, auditId }: { orgId: string; auditId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        className={buttonCls}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await trpc.audit.replay.mutate({ orgId, auditId });
            router.refresh();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Trying again…" : "Replay"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
