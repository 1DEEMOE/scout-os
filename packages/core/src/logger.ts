import pino from "pino";
import { redactText } from "./security/secrets";

/** Structured JSON logger. Secrets and tokens are redacted by path; PII is scrubbed by value. */
/** Field names that hold credentials, at any depth up to three levels. */
const SECRET_FIELD_LIST = ["password", "token", "accessToken", "refreshToken", "access_token", "refresh_token", "id_token", "apiKey", "secret", "secretCiphertext", "secret_ciphertext", "tokens", "authorization", "bearer"];
const SECRET_FIELDS = new Set(SECRET_FIELD_LIST.map((f) => f.toLowerCase()));
export const REDACT_PATHS = [
  ...SECRET_FIELD_LIST,
  ...SECRET_FIELD_LIST.map((f) => `*.${f}`),
  ...SECRET_FIELD_LIST.map((f) => `*.*.${f}`),
  "headers.cookie",
  "headers.authorization",
];

/** Field names that carry message content or counterparties (G8): redacted wherever they appear. */
const PII_FIELDS = new Set(["body", "content", "text", "subject", "to", "from", "sender", "recipients", "email", "address", "html", "raw", "phone", "customerPhone"]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![A-Za-z0-9])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

/**
 * Deep-scrubs a log object (G8): values under PII field names are replaced, and
 * email addresses inside any remaining string are masked. Ids, counts, enum
 * names and timestamps pass through untouched. Returns a copy; never mutates.
 */
export function scrubPii(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]"));
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubPii(v, seen));
  if (value instanceof Error) {
    const cause = (value as { cause?: unknown }).cause;
    return {
      name: value.name,
      message: scrubPii(value.message, seen),
      cause: cause === undefined ? undefined : scrubPii(cause, seen),
      stack: undefined,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PII_FIELDS.has(k) || SECRET_FIELDS.has(k.toLowerCase()) ? "[REDACTED]" : scrubPii(v, seen);
  }
  return out;
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
