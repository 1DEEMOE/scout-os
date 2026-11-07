import { createHash } from "node:crypto";

export interface InboundMessage {
  externalId: string;
  threadId: string;
  rfc822MessageId?: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  sentAt: Date;
  direction: "inbound" | "outbound";
}

/** A file on a draft. The sha256 is of the raw bytes, so a swapped file changes the approval. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  sha256: string;
  size: number;
}

export interface OutboundDraft {
  threadId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  attachments?: MailAttachment[];
  /** Deterministic RFC 822 Message-ID; how a retried call finds the earlier one. */
  messageId: string;
}

/** The provider draft a send approval is bound to. */
export interface MailDraft {
  draftId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  body?: string;
  attachments?: MailAttachment[];
}

/** What the inbox agent needs from a mailbox. Gmail is one implementation. */
export interface MailProvider {
  readonly name: string;
  readonly mock: boolean;
  listRecent(opts: { cursor?: string | null; max?: number }): Promise<{ messages: InboundMessage[]; cursor: string | null }>;
  createDraft(draft: OutboundDraft): Promise<{ draftId: string }>;
  /** Replaces the body of a draft the mailbox already holds. The id stays the same. */
  updateDraft(draftId: string, draft: OutboundDraft): Promise<{ draftId: string }>;
  /** Looks for an existing draft carrying this Message-ID, including every recipient header and attachment. */
  findDraft(messageId: string): Promise<MailDraft | undefined>;
  sendDraft(draftId: string): Promise<{ externalId: string }>;
  /** Looks for a sent message carrying this Message-ID. */
  findSent(messageId: string): Promise<{ externalId: string } | undefined>;
}

/** Message-ID derived from the step's idempotency key: same step, same id. */
export function messageIdFor(idempotencyKey: string, domain = "workforce-os.invalid"): string {
  return `<wos-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}@${domain}>`;
}

/** Strips CR/LF so header values can't inject extra headers. */
function header(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/** Builds a plain-text RFC 822 message for the Gmail API ("raw", base64url). */
export function buildRfc822(d: OutboundDraft & { from?: string }): string {
  const lines = [
    ...(d.from ? [`From: ${header(d.from)}`] : []),
    `To: ${d.to.map(header).join(", ")}`,
    ...(d.cc?.length ? [`Cc: ${d.cc.map(header).join(", ")}`] : []),
    ...(d.bcc?.length ? [`Bcc: ${d.bcc.map(header).join(", ")}`] : []),
    ...(d.replyTo?.length ? [`Reply-To: ${d.replyTo.map(header).join(", ")}`] : []),
    `Subject: ${header(d.subject)}`,
    `Message-ID: ${header(d.messageId)}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${header(d.inReplyTo)}`, `References: ${header(d.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    d.body.replace(/\r?\n/g, "\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/**
 * MOCK mailbox for tests and demos. Holds messages in memory; nothing is sent.
 */
export class FakeMailProvider implements MailProvider {
  readonly name = "fake-mail";
  readonly mock = true;
  inbox: InboundMessage[] = [];
  drafts = new Map<string, OutboundDraft>();
  sent = new Map<string, OutboundDraft & { externalId: string }>();
  sendCalls = 0;
  private nextDraft = 0;
  private nextSent = 0;
  /** Simulates the provider sending, then the connection dropping. */
  dropAfterSend = 0;
  /** While set, the in-flight send waits here so another run can observe it. */
  sendGate: Promise<void> | null = null;
  /** Throw after the gate, before anything is delivered. */
  rejectSend = false;

  async listRecent(opts: { cursor?: string | null; max?: number }) {
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const messages = this.inbox.slice(start, start + (opts.max ?? 50));
    return { messages, cursor: String(start + messages.length) };
  }

  async createDraft(draft: OutboundDraft) {
    const existing = await this.findDraft(draft.messageId);
    if (existing) return existing;
    const draftId = `draft_${++this.nextDraft}`;
    this.drafts.set(draftId, draft);
    return { draftId };
  }

  async updateDraft(draftId: string, draft: OutboundDraft) {
    const current = this.drafts.get(draftId);
    if (!current) throw new Error(`MOCK: draft ${draftId} not found`);
    this.drafts.set(draftId, { ...draft, messageId: current.messageId });
    return { draftId };
  }

  async findDraft(messageId: string): Promise<MailDraft | undefined> {
    for (const [draftId, d] of this.drafts) {
      if (d.messageId === messageId) {
        return {
          draftId,
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          replyTo: d.replyTo,
          subject: d.subject,
          body: d.body,
          attachments: d.attachments,
        };
      }
    }
    return undefined;
  }

  async sendDraft(draftId: string) {
    this.sendCalls++;
    const gate = this.sendGate;
    if (gate) {
      this.sendGate = null;
      await gate;
    }
    if (this.rejectSend) {
      this.rejectSend = false;
      throw new Error("MOCK provider rejected the send");
    }
    const d = this.drafts.get(draftId);
    if (!d) throw new Error(`MOCK: draft ${draftId} not found`);
    const externalId = `sent_${++this.nextSent}`;
    this.sent.set(externalId, { ...d, externalId });
    this.drafts.delete(draftId);
    if (this.dropAfterSend > 0) {
      this.dropAfterSend--;
      throw new Error("MOCK connection reset after send");
    }
    return { externalId };
  }

  async findSent(messageId: string) {
    for (const s of this.sent.values()) if (s.messageId === messageId) return { externalId: s.externalId };
    return undefined;
  }
}
