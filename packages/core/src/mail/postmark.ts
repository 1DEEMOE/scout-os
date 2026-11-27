import { logger } from "../logger";
import type { MailSender, OutboundMail } from "./sender";
import type { SuppressionStore } from "./bounces";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Platform email over Postmark's HTTP API (transactional stream).
 * UNVERIFIED against live Postmark: tested only with an injected fake fetch.
 */
export class PostmarkMailSender implements MailSender {
  readonly name = "postmark";
  readonly mock = false;
  constructor(private readonly token: string, private readonly from: string, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): PostmarkMailSender | null {
    const token = env.POSTMARK_SERVER_TOKEN?.trim();
    if (!token) return null;
    const from = env.MAIL_FROM?.trim();
    if (!from) throw new Error("MAIL_FROM is required when POSTMARK_SERVER_TOKEN is set");
    return new PostmarkMailSender(token, from, fetchImpl);
  }

  async send(mail: OutboundMail): Promise<{ id: string }> {
    const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-postmark-server-token": this.token },
      body: JSON.stringify({ From: this.from, To: mail.to, Subject: mail.subject, TextBody: mail.text, MessageStream: "outbound" }),
    });
    const data = (await res.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string };
    if (!res.ok || (data.ErrorCode ?? 0) !== 0) throw new Error(`Postmark send failed (HTTP ${res.status}, code ${data.ErrorCode ?? "?"})`);
    logger.info({ mail: { subject: mail.subject, provider: "postmark" } }, "platform email sent");
    return { id: data.MessageID ?? "postmark" };
  }
}

/** Refuses to send to addresses that hard-bounced or complained. Protects sender reputation. */
export class SuppressingMailSender implements MailSender {
  constructor(private readonly inner: MailSender, private readonly store: SuppressionStore) {}
  get name() { return this.inner.name; }
  get mock() { return this.inner.mock; }
  async send(mail: OutboundMail): Promise<{ id: string }> {
    if (await this.store.isSuppressed(mail.to)) throw new Error("recipient is suppressed (previous bounce or complaint); email not sent");
    return this.inner.send(mail);
  }
}
