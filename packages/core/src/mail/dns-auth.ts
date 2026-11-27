/** Offline SPF/DKIM/DMARC evaluation of already-fetched TXT records. No network. */
export interface DomainAuthInput {
  spf: string[];                         // TXT records at the domain
  dmarc: string[];                       // TXT records at _dmarc.<domain>
  dkim: Record<string, string[]>;        // selector -> TXT records at <selector>._domainkey.<domain>
  /** Expected include for the sending provider, e.g. "spf.mtasv.net" for Postmark. */
  providerInclude?: string;
}
export interface AuthFinding { level: "error" | "warn" | "ok"; code: string; message: string }
export interface DomainAuthReport { ready: boolean; findings: AuthFinding[] }

const f = (level: AuthFinding["level"], code: string, message: string): AuthFinding => ({ level, code, message });

export function evaluateDomainAuth(i: DomainAuthInput): DomainAuthReport {
  const out: AuthFinding[] = [];
  const spf = i.spf.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) out.push(f("error", "spf_missing", "No SPF record. Receivers can't tell who may send for this domain."));
  else if (spf.length > 1) out.push(f("error", "spf_multiple", "More than one SPF record. SPF fails with multiple records; merge them."));
  else {
    const r = spf[0]!;
    if (/\+all\b|\s\?all\b/.test(r)) out.push(f("error", "spf_open", "SPF allows anyone to send (+all / ?all)."));
    else if (!/\s[-~]all\s*$/.test(r.trim())) out.push(f("warn", "spf_no_all", "SPF has no closing -all or ~all."));
    else out.push(f("ok", "spf_ok", "SPF present with a closing policy."));
    const lookups = (r.match(/\b(include:|a\b|mx\b|ptr\b|exists:|redirect=)/gi) ?? []).length;
    if (lookups > 10) out.push(f("error", "spf_lookups", `SPF needs about ${lookups} DNS lookups; the limit is 10.`));
    if (i.providerInclude && !r.includes(i.providerInclude)) out.push(f("error", "spf_provider", `SPF does not include ${i.providerInclude}.`));
  }
  const goodDkim = Object.entries(i.dkim).filter(([, recs]) => recs.some((x) => /v=DKIM1/i.test(x) && /p=[A-Za-z0-9+/=]{20,}/.test(x)));
  if (goodDkim.length === 0) out.push(f("error", "dkim_missing", "No valid DKIM key found for any checked selector."));
  else out.push(f("ok", "dkim_ok", `DKIM key found for selector ${goodDkim.map(([s]) => s).join(", ")}.`));
  const dm = i.dmarc.find((r) => /^v=DMARC1/i.test(r.trim()));
  if (!dm) out.push(f("error", "dmarc_missing", "No DMARC record at _dmarc."));
  else {
    const p = /(?:^|;)\s*p=(none|quarantine|reject)/i.exec(dm)?.[1]?.toLowerCase();
    if (!p) out.push(f("error", "dmarc_invalid", "DMARC record has no valid p= policy."));
    else if (p === "none") out.push(f("warn", "dmarc_monitor", "DMARC is monitor-only (p=none). Fine to start; move to quarantine once reports look clean."));
    else out.push(f("ok", "dmarc_enforced", `DMARC enforces p=${p}.`));
    if (!/rua=mailto:/i.test(dm)) out.push(f("warn", "dmarc_no_reports", "No rua= address, so you won't receive DMARC reports."));
  }
  return { ready: !out.some((x) => x.level === "error"), findings: out };
}
