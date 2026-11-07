"use client";

export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-display font-semibold">Something went wrong</h1>
      <p>This page didn&apos;t load. Your approvals, routines, and settings are unchanged.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => reset()} className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-on-accent">Try again</button>
        <a href="/orgs" className="inline-flex min-h-11 items-center rounded-full border border-line px-5">Back to workspaces</a>
      </div>
    </main>
  );
}
