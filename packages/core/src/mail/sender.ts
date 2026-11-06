import { logger } from "../logger";
import { SmtpMailSender } from "./smtp";

/**
 * Platform email sender (verification, password reset). This is the SaaS's own
 * mail, not a tenant's mailbox — tenant mail goes through the inbox integration.
 *
 * SMTP when SMTP_URL and MAIL_FROM are set (see ./smtp.ts); otherwise the
 * labelled MOCK console sender, which logs and keeps messages in memory and
 * never delivers. Callers must check `mock` before telling anyone an email
 * was sent (Law 2).
 */

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

export interface MailSender {
  readonly name: string;
  /** True when nothing is actually sent (console sender). */
  readonly mock: boolean;
  send(mail: OutboundMail): Promise<{ id: string }>;
}

/** MOCK sender: writes the message to an in-memory list and the log. */
export class ConsoleMailSender implements MailSender {
  readonly name = "console";
  readonly mock = true;
  readonly sent: OutboundMail[] = [];

  async send(mail: OutboundMail): Promise<{ id: string }> {
    this.sent.push(mail);
    // Subject only: the recipient is personal data and the body holds one-time links.
    logger.info(
      { mail: { subject: mail.subject, mock: true, ...(process.env.WOS_MAIL_DEBUG_BODY === "1" ? { to: mail.to, text: mail.text } : {}) } },
      "MOCK email (console sender): not delivered",
    );
    return { id: `console_${this.sent.length}` };
  }
}

let sender: MailSender | undefined;

/** Process-wide sender: SMTP if configured (and not in mock mode), else the MOCK console sender. */
export function getMailSender(): MailSender {
  sender ??= (process.env.WOS_MOCK_MODE === "1" ? null : SmtpMailSender.fromEnv()) ?? new ConsoleMailSender();
  return sender;
}

/** True when platform email really goes out. Screens use it to say what happened. */
export function platformEmailConfigured(): boolean {
  return !getMailSender().mock;
}

/** For tests only. */
export function setMailSenderForTests(s: MailSender): void {
  sender = s;
}
