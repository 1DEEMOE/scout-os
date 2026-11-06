import type { NextConfig } from "next";

/**
 * Security headers on every response (Phase 0 finding E-2): the approval
 * pages must not be framed by another site (clickjacking on Approve).
 */
export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const config: NextConfig = {
  transpilePackages: ["@wos/core", "@wos/db"],
  serverExternalPackages: ["pg", "pino", "@opentelemetry/sdk-node"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default config;
