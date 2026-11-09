/**
 * Outbound fetches must hit an allowlisted https host. User-supplied URLs are not fetched.
 * api.weather.gov is the only host the product calls directly today.
 */
const ALLOWED_HOSTS = new Set(["api.weather.gov"]);

export class UnsafeUrlError extends Error {
  readonly code = "UNSAFE_URL";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Fetches an allowlisted URL and does not follow redirects blindly.
 * Each hop is checked again. A redirect to any other host is rejected.
 */
export async function fetchAllowlisted(
  raw: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  hops = 2,
): Promise<Response> {
  const url = assertSafeOutbound(raw);
  const res = await fetchImpl(url.toString(), { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    if (hops <= 0) throw new UnsafeUrlError("Too many redirects");
    const location = res.headers.get("location");
    if (!location) throw new UnsafeUrlError("Redirect is missing a location");
    return fetchAllowlisted(new URL(location, url).toString(), init, fetchImpl, hops - 1);
  }
  return res;
}

export function assertSafeOutbound(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Outbound URL is not absolute");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("Outbound URL must be https");
  if (url.username || url.password) throw new UnsafeUrlError("Outbound URL must not carry credentials");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new UnsafeUrlError(`Outbound host ${url.hostname} is not allowlisted`);
  if (url.port && url.port !== "443") throw new UnsafeUrlError("Outbound URL must use the default https port");
  return url;
}
