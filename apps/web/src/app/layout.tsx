import type { Metadata, Viewport } from "next";
import { BRAND } from "@/brand";
import { Frame } from "./frame";
import { NAV_BOOT, THEME_BOOT } from "./boot";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.promise,
  applicationName: BRAND.name,
  robots: { index: false, follow: false },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: BRAND.name, statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#120e0c" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0c0a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT + NAV_BOOT }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Frame>{children}</Frame>
      </body>
    </html>
  );
}
