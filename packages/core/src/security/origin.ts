/**
 * Browser mutations must match a configured origin (scheme, host, and port).
 * X-Forwarded-Host is ignored. A missing Origin is rejected.
 * APP_ORIGIN may be a comma-separated allowlist. BETTER_AUTH_URL is included
 * when set. With neither, the request URL's own origin is the only match.
 */
export function allowedOrigins(fallbackUrl?: string): string[] {
  const configured = [process.env.APP_ORIGIN ?? "", process.env.BETTER_AUTH_URL ?? ""]
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  if (!fallbackUrl) return [];
  try {
    return [new URL(fallbackUrl).origin];
  } catch {
    return [];
  }
}

export function sameOrigin(req: { url: string; headers: { get(name: string): string | null } }): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let given: URL;
  try {
    given = new URL(origin);
  } catch {
    return false;
  }
  return allowedOrigins(req.url).some((allowed) => {
    try {
      const want = new URL(allowed);
      return given.protocol === want.protocol && given.host === want.host;
    } catch {
      return false;
    }
  });
}
