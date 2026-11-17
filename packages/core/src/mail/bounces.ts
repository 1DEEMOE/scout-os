/**
 * Bounce and complaint handling for platform email (magic links, resets, receipts).
 * Pure parsing + decisions; persistence goes through a SuppressionStore.
 *
 * UNVERIFIED against live provider payloads: field names follow the providers' documented
 * webhook formats and must be checked against a real test event before launch.
 * Amazon SNS messages must have their signature verified by the caller BEFORE parsing here.
 */
export type MailEventKind = "hard_bounce" | "soft_bounce" | "complaint";
export interface MailEvent { kind: MailEventKind; address: string; provider: "postmark" | "ses"; detail?: string }

const HARD = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated"]);
const SOFT = new Set(["SoftBounce", "Transient", "DnsError", "SMTPApiError", "AutoResponder", "Blocked"]);
const norm = (a: string) => a.trim().toLowerCase();

export function parsePostmarkEvent(body: unknown): MailEvent | null {
  const b = body as { RecordType?: string; Type?: string; Email?: string; Details?: string } | null;
  if (!b?.Email || typeof b.Email !== "string") return null;
  if (b.RecordType === "SpamComplaint") return { kind: "complaint", address: norm(b.Email), provider: "postmark", detail: b.Type };
  if (b.RecordType !== "Bounce") return null;
  if (HARD.has(b.Type ?? "")) return { kind: "hard_bounce", address: norm(b.Email), provider: "postmark", detail: b.Type };
  if (SOFT.has(b.Type ?? "")) return { kind: "soft_bounce", address: norm(b.Email), provider: "postmark", detail: b.Type };
  return null; // unknown types are ignored, never guessed into a suppression
}

/** `body` is the SNS notification's already-verified `Message` (a JSON string or object). */
export function parseSesEvents(message: unknown): MailEvent[] {
  let m: { notificationType?: string; bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] }; complaint?: { complainedRecipients?: { emailAddress?: string }[] } };
  try { m = typeof message === "string" ? JSON.parse(message) : (message as typeof m); } catch { return []; }
  const out: MailEvent[] = [];
  if (m?.notificationType === "Bounce" && m.bounce) {
    const kind: MailEventKind = m.bounce.bounceType === "Permanent" ? "hard_bounce" : "soft_bounce";
    for (const r of m.bounce.bouncedRecipients ?? []) if (r.emailAddress) out.push({ kind, address: norm(r.emailAddress), provider: "ses" });
  }
  if (m?.notificationType === "Complaint" && m.complaint) {
    for (const r of m.complaint.complainedRecipients ?? []) if (r.emailAddress) out.push({ kind: "complaint", address: norm(r.emailAddress), provider: "ses" });
  }
  return out;
}

export interface SuppressionStore {
  isSuppressed(address: string): Promise<boolean>;
  suppress(address: string, reason: "bounce" | "complaint"): Promise<void>;
  /** Count of soft bounces in the recent window, including the one being handled. */
  recordSoftBounce(address: string): Promise<number>;
}

export const SOFT_BOUNCE_LIMIT = 3;

/** Hard bounces and complaints suppress at once; soft bounces only after repeated failures. */
export async function handleMailEvent(store: SuppressionStore, ev: MailEvent): Promise<"suppressed" | "counted" | "ignored"> {
  if (ev.kind === "hard_bounce") { await store.suppress(ev.address, "bounce"); return "suppressed"; }
  if (ev.kind === "complaint") { await store.suppress(ev.address, "complaint"); return "suppressed"; }
  const n = await store.recordSoftBounce(ev.address);
  if (n >= SOFT_BOUNCE_LIMIT) { await store.suppress(ev.address, "bounce"); return "suppressed"; }
  return "counted";
}

export class InMemorySuppressionStore implements SuppressionStore {
  readonly suppressed = new Map<string, "bounce" | "complaint">();
  readonly soft = new Map<string, number>();
  async isSuppressed(a: string) { return this.suppressed.has(norm(a)); }
  async suppress(a: string, r: "bounce" | "complaint") { this.suppressed.set(norm(a), r); }
  async recordSoftBounce(a: string) { const n = (this.soft.get(norm(a)) ?? 0) + 1; this.soft.set(norm(a), n); return n; }
}

/** Constant-time shared-secret check for provider webhooks. */
export function webhookSecretOk(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
