/**
 * Checks the platform's sending domain for SPF / DKIM / DMARC readiness.
 *
 *   pnpm exec tsx scripts/check-mail-dns.mts [--domain example.com] [--selector pm]
 *
 * Defaults: domain from MAIL_FROM, DKIM selectors from MAIL_DKIM_SELECTORS (comma-separated).
 * Read-only: it only resolves public DNS TXT records and prints findings.
 */
import { resolveTxt } from "node:dns/promises";
import { evaluateDomainAuth } from "../packages/core/src/mail/dns-auth";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const from = process.env.MAIL_FROM ?? "";
const domain = arg("domain") ?? (from.includes("@") ? from.split("@").pop()! : from.trim());
if (!domain || !domain.includes(".")) {
  console.error("No domain. Pass --domain example.com or set MAIL_FROM.");
  process.exit(1);
}

const selectors = (arg("selector") ? [arg("selector")!] : (process.env.MAIL_DKIM_SELECTORS ?? "pm").split(",").map((s) => s.trim()).filter(Boolean));

async function txt(host: string): Promise<string[]> {
  try {
    return (await resolveTxt(host)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

const [spf, dmarc, dkimEntries] = await Promise.all([
  txt(domain),
  txt(`_dmarc.${domain}`),
  Promise.all(selectors.map(async (s) => [s, await txt(`${s}._domainkey.${domain}`)] as const)),
]);

const report = evaluateDomainAuth({
  spf,
  dmarc,
  dkim: Object.fromEntries(dkimEntries),
  providerInclude: process.env.POSTMARK_SERVER_TOKEN ? "spf.mtasv.net" : undefined,
});

console.log(`Domain: ${domain}`);
for (const f of report.findings) console.log(`${f.level === "error" ? "FAIL" : f.level === "warn" ? "warn" : " ok "}  ${f.code}: ${f.message}`);
console.log(report.ready ? "\nREADY: receivers can authenticate this domain." : "\nNOT READY: fix the FAIL lines before enabling live email.");
process.exit(report.ready ? 0 : 2);
