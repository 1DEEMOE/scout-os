/** High-confidence secret shapes. The patterns live here so a repo scan can skip this file. */

const FINDINGS: { name: string; re: RegExp }[] = [
  { name: "stripe_live", re: /sk_live_[0-9A-Za-z]{8,}/ },
  { name: "stripe_test", re: /sk_test_[0-9A-Za-z]{8,}/ },
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "provider_sk", re: /sk-[A-Za-z0-9_-]{10,}/ },
  { name: "xai", re: /xai-[A-Za-z0-9_-]{8,}/ },
  { name: "google", re: /AIza[0-9A-Za-z_-]{10,}/ },
  { name: "github", re: /ghp_[A-Za-z0-9]{8,}/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private_key", re: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { name: "sendgrid", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._~+/-]{8,}/i },
];

export function secretFindings(text: string): string[] {
  return FINDINGS.filter((f) => f.re.test(text)).map((f) => f.name);
}

/** Replaces secret-shaped substrings. Used on error text before it is logged or stored. */
export function redactText(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/sk_live_[0-9A-Za-z]+/g, "[REDACTED]")
    .replace(/sk_test_[0-9A-Za-z]+/g, "[REDACTED]")
    .replace(/xai-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{8,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]");
}
