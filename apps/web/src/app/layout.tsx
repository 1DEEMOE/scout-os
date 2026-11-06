import type { Metadata } from "next";
import { BRAND } from "@/brand";
import { BrandMark } from "./brand-mark";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.promise,
  applicationName: BRAND.name,
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
            <a href="/orgs" aria-label={`${BRAND.name} home`}><BrandMark /></a>
            <span className="rounded-md border border-line px-2.5 py-1 text-sm text-muted">Development build</span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">{children}</main>
      </body>
    </html>
  );
}
