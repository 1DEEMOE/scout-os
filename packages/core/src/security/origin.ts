/**
 * Browser mutations must come from this host. A missing Origin is rejected:
 * a real browser sends one on POST. Webhooks are not checked here.
 */
export function sameOrigin(req: { url: string; headers: { get(name: string): string | null } }): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || req.headers.get("host") || safeHost(req.url);
  return !!host && originHost.toLowerCase() === host.toLowerCase();
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "";
  }
}
