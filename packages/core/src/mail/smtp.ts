import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../logger";
import type { MailSender, OutboundMail } from "./sender";

/**
 * Real platform email over SMTP (password resets, invitations, verification).
 * Provider-neutral: Postmark, SES, Resend, Mailgun and Google Workspace all
 * accept SMTP. Configure with SMTP_URL (smtps://user:pass@host:465 or
 * smtp://user:pass@host:587) and MAIL_FROM ("Scout OS <no-reply@yourdomain>").
 *
 * UNVERIFIED against a live provider in this repository: covered by tests
 * through nodemailer's stream transport, not by a real send.
 */
export class SmtpMailSender implements MailSender {
  readonly name = "smtp";
  readonly mock = false;

  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SmtpMailSender | null {
    const url = env.SMTP_URL?.trim();
    const from = env.MAIL_FROM?.trim();
    if (!url) return null;
    if (!/^smtps?:\/\//.test(url)) throw new Error("SMTP_URL must start with smtp:// or smtps://");
    if (!from) throw new Error("MAIL_FROM is required when SMTP_URL is set");
    return new SmtpMailSender(nodemailer.createTransport(url), from);
  }

  async send(mail: OutboundMail): Promise<{ id: string }> {
    const info = (await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text })) as { messageId?: string };
    // Subject only: recipients are personal data and bodies hold one-time links.
    logger.info({ mail: { subject: mail.subject, provider: "smtp" } }, "platform email sent");
    return { id: info.messageId ?? "smtp" };
  }
}
