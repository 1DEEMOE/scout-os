"use client";
import { usePathname } from "next/navigation";
import { BRAND } from "@/brand";
import { BrandMark } from "./brand-mark";
import { TextSizeToggle, ThemeToggle } from "./theme";

/**
 * Org pages bring their own shell (sidebar, chat). Everything else (sign-in,
 * booking links, the org list) gets a calm centered frame.
 */
export function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (/^\/orgs\/[^/]+/.test(path)) return <>{children}</>;
  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4 sm:px-8">
          <a href="/orgs" aria-label={`${BRAND.name} home`} className="rounded-lg"><BrandMark /></a>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="hidden rounded-full border border-line px-3 py-1 text-sm text-muted sm:inline">Development build</span>
            <TextSizeToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10 sm:px-8 sm:py-14">{children}</main>
    </>
  );
}
