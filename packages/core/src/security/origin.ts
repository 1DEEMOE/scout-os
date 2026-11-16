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
  return originAllowed(req, origin);
}

/**
 * Gate for unauthenticated public API endpoints (e.g. front-desk booking).
 *
 * These endpoints use no session cookie — the link token is the credential —
 * so there is no ambient authority a browser could be tricked into spending.
 * Browsers always send an Origin header on cross-site POSTs; server-to-server
 * clients, including the outside AI booking agents this product is designed
 * for, usually send none. Therefore:
 * - no Origin header → allowed (non-browser client; rate limits still apply)
 * - allowlisted Origin → allowed (our own booking page)
 * - any other Origin → blocked (a browser driven by a third-party site)
 */
export function publicClientAllowed(req: { url: string; headers: { get(name: string): string | null } }): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  return originAllowed(req, origin);
}

function originAllowed(req: { url: string; headers: { get(name: string): string | null } }, origin: string): boolean {
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
