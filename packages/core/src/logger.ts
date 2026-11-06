import pino from "pino";

/** Structured JSON logger. Secrets and tokens are redacted by path; PII is scrubbed by value. */
/** Field names that hold credentials, at any depth up to three levels. */
const SECRET_FIELDS = ["password", "token", "accessToken", "refreshToken", "access_token", "refresh_token", "id_token", "apiKey", "secret", "secretCiphertext", "secret_ciphertext", "tokens", "authorization"];
export const REDACT_PATHS = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((f) => `*.${f}`),
  ...SECRET_FIELDS.map((f) => `*.*.${f}`),
  "headers.cookie",
  "headers.authorization",
];

/** Field names that carry message content or counterparties (G8): redacted wherever they appear. */
const PII_FIELDS = new Set(["body", "content", "text", "subject", "to", "from", "sender", "recipients", "email", "address", "html", "raw"]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Deep-scrubs a log object (G8): values under PII field names are replaced, and
 * email addresses inside any remaining string are masked. Ids, counts, enum
 * names and timestamps pass through untouched. Returns a copy; never mutates.
 */
export function scrubPii(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === "string") return value.replace(EMAIL_RE, "[email]");
  if (Array.isArray(value)) return value.map((v) => scrubPii(v, depth + 1));
  if (typeof value === "object") {
    if (value instanceof Error) {
      // Error messages can quote provider responses (which may contain addresses).
      return { name: value.name, message: scrubPii(value.message, depth + 1), stack: undefined };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_FIELDS.has(k) ? "[REDACTED]" : scrubPii(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function makeLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: "workforce-os" },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      formatters: {
        log(obj) {
          return scrubPii(obj) as Record<string, unknown>;
        },
      },
    },
    destination,
  );
}

export const logger = makeLogger();
