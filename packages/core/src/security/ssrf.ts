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
