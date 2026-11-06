"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the page every few seconds while `active` (e.g. hand-offs still
 * running), for up to `maxSeconds`, then stops and says so.
 */
export function AutoRefresh({ active, everySeconds = 3, maxSeconds = 120 }: { active: boolean; everySeconds?: number; maxSeconds?: number }) {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started > maxSeconds * 1000) {
        clearInterval(id);
        setStopped(true);
        return;
      }
      router.refresh();
    }, everySeconds * 1000);
    return () => clearInterval(id);
  }, [active, everySeconds, maxSeconds, router]);
  if (!active) return null;
  return (
    <p role="status" aria-live="polite" className="text-xs text-muted">
      {stopped ? "Still running. Refresh the page to check again." : "Updating as the hand-offs progress…"}
    </p>
  );
}
