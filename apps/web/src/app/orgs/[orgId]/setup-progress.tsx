"use client";
import { useEffect, useState } from "react";
import { minutesText } from "./welcome/progress";

/**
 * Slim, dismissible setup progress. Dismissing hides it in this browser only
 * (a per-viewer convenience); it never marks anything done.
 */
export function SetupProgress({ orgId, done, total, nextLabel, minutesLeft }: { orgId: string; done: number; total: number; nextLabel: string | null; minutesLeft: number }) {
  const key = `scout-setup-dismissed:${orgId}`;
  const [hidden, setHidden] = useState(true); // avoid a flash before we know
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(key) === "1";
    } catch {
      // Storage blocked: show it.
    }
    setHidden(dismissed);
  }, [key]);
  if (hidden) return null;
  const pct = Math.round((done / Math.max(total, 1)) * 100);
  return (
    <section aria-label="Setup progress" className="motion-rise mb-10 flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="font-medium">Setup: {done} of {total} done <span className="font-normal text-muted">· {minutesText(minutesLeft)}</span></p>
        {nextLabel && <p className="truncate text-small text-muted">Next: {nextLabel}</p>}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-soft" role="progressbar" aria-label="Setup progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a href={`/orgs/${orgId}/welcome`} className="accent-fill inline-flex min-h-11 items-center rounded-full bg-accent px-5 font-medium text-on-accent transition-[filter] duration-150 hover:brightness-110">
          Continue setup
        </a>
        <button
          type="button"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(key, "1");
            } catch {
              // Hidden for this page view only.
            }
          }}
          className="inline-flex min-h-11 items-center rounded-full px-4 text-small text-muted transition-colors duration-150 hover:bg-soft hover:text-ink"
        >
          Hide
        </button>
      </div>
    </section>
  );
}
