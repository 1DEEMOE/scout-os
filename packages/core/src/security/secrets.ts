/** High-confidence secret shapes. The patterns live here so a repo scan can skip this file. */

const FINDINGS: { name: string; re: RegExp }[] = [
  { name: "stripe_live", re: /sk_live_[0-9A-Za-z]{8,}/ },
  { name: "stripe_test", re: /sk_test_[0-9A-Za-z]{8,}/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private_key", re: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { name: "sendgrid", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
];

export function secretFindings(text: string): string[] {
  return FINDINGS.filter((f) => f.re.test(text)).map((f) => f.name);
}

/** Replaces secret-shaped substrings. Used on error text before it is logged or stored. */
export function redactText(value: string): string {
  return value
    .replace(/sk_live_[0-9A-Za-z]+/g, "[REDACTED]")
    .replace(/sk_test_[0-9A-Za-z]+/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
}
