"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, MockBadge } from "../../../ui";

type Source = { id: string; label: string; kind: string; mock: boolean; records: number; used: number; note: string };

/** "Find jobs near me": runs every signal adapter for the service area, then scores what it found. */
export function FinderCard({ orgId, canRun, live }: { orgId: string; canRun: boolean; live: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sources: Source[]; prospectsAdded: number; opportunities: number } | null>(null);
  return (
    <section aria-labelledby="finder-title" className="mb-8 flex flex-col gap-5 rounded-[var(--radius-card)] border border-line bg-surface p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 id="finder-title" className="flex flex-wrap items-center gap-2 text-xl font-semibold">Find local jobs {live ? <span className="rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-sm font-normal">Live storm reports</span> : <MockBadge />}</h2>
          <p className="mt-2 text-muted">
            {live
              ? "Reads the last three days of NOAA storm reports for your states and scores the customers and leads you've imported against them. Reports are preliminary; they say weather happened nearby, not that a roof was damaged."
              : "Looks at storm reports and building permits in your service area, keeps roofs that are 15+ years old near fresh storm damage, and scores each one. The data sources are MOCK until live feeds are connected."}
          </p>
        </div>
        {canRun && (
          <button
            type="button"
            disabled={busy}
            className={buttonCls}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setResult(await trpc.scout.findOpportunities.mutate({ orgId }));
                router.refresh();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Looking…" : "Find jobs near me"}
          </button>
        )}
      </div>
      <ErrorText message={error} />
      {result && (
        <div role="status" className="flex flex-col gap-4">
          <p className="font-medium">
            {result.prospectsAdded ? `Added ${result.prospectsAdded} new ${result.prospectsAdded === 1 ? "lead" : "leads"}.` : "No new leads this time."} {result.opportunities} {live ? "" : "sample "}{result.opportunities === 1 ? "opportunity" : "opportunities"} to look at below.
          </p>
          <ul aria-label="Sources checked" className="flex flex-col gap-3">
            {result.sources.map((s) => (
              <li key={s.id} className="rounded-2xl border border-line px-4 py-3">
                <p className="font-medium">{s.label}: {s.records} found, {s.used} used</p>
                <p className="mt-1 text-small text-muted">{s.note}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
