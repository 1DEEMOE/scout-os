/**
 * Rule-based lead scoring. Deterministic and fully transparent: every point
 * comes from a fixed rule below, and the score always carries the list of
 * rules that fired so the UI can explain itself ("why this score"). No
 * per-org rule DSL — letting workspace data define scoring rules would be a
 * config-injection surface, and a score nobody can explain is worse than a
 * simple one everybody can.
 */

export interface ScoreContact {
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
}

export interface ScoreFacts {
  hasOpenDeal: boolean;
  /** ISO timestamp of the most recent activity we know about, if any. */
  lastActivityAt: string | null;
  inboundMessageCount: number;
}

export interface ScoreReason {
  id: string;
  points: number;
  label: string;
}

export type ScoreGrade = "hot" | "warm" | "cold";

export interface ContactScore {
  score: number;
  grade: ScoreGrade;
  reasons: ScoreReason[];
}

/** Free mailbox providers: a business domain is a mild buying signal. */
const FREE_MAIL = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "gmx.com",
  "msn.com",
  "ymail.com",
]);

const RECENT_WINDOW_MS = 30 * 86_400_000;

/**
 * Scores a contact 0–100 from fixed rules. `now` is injectable so tests are
 * deterministic. Pure: no I/O, no clock beyond the argument.
 */
export function scoreContact(contact: ScoreContact, facts: ScoreFacts, now: Date = new Date()): ContactScore {
  const reasons: ScoreReason[] = [];
  const add = (id: string, points: number, label: string) => reasons.push({ id, points, label });

  const email = contact.email?.trim().toLowerCase() ?? "";
  const domain = email.split("@")[1] ?? "";

  if (contact.company?.trim()) add("company", 15, "Has a company");
  if (contact.phone?.trim()) add("phone", 10, "Left a phone number");
  if (email && domain && !FREE_MAIL.has(domain)) add("business_email", 15, "Uses a business email domain");
  if (email) add("has_email", 5, "Has an email address");
  if (contact.source === "inbox") add("inbound", 20, "Came to you (inbound)");
  if (facts.inboundMessageCount >= 2) add("engaged", 10, "Wrote in more than once");
  if (facts.hasOpenDeal) add("open_deal", 20, "Has an open deal");
  if (facts.lastActivityAt) {
    const at = new Date(facts.lastActivityAt).getTime();
    if (!Number.isNaN(at) && now.getTime() - at <= RECENT_WINDOW_MS) add("recent", 15, "Active in the last 30 days");
  }

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  const grade: ScoreGrade = score >= 60 ? "hot" : score >= 30 ? "warm" : "cold";
  return { score, grade, reasons };
}
