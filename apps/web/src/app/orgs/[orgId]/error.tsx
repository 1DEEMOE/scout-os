"use client";

export default function OrgError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const orgId = typeof window === "undefined" ? "" : (window.location.pathname.match(/^\/orgs\/([^/]+)/)?.[1] ?? "");
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 py-16">
      <h1 className="text-display font-semibold">This page hit a problem</h1>
      <p>Scout couldn&apos;t finish loading it. Nothing was sent, paid, or approved because of this.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => reset()} className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-on-accent">Try again</button>
        {orgId ? <a href={`/orgs/${orgId}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-5">Back to Today</a> : <a href="/orgs" className="inline-flex min-h-11 items-center rounded-full border border-line px-5">Back to workspaces</a>}
      </div>
    </main>
  );
}
