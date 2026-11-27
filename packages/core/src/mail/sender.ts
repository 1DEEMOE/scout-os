import { logger } from "../logger";
import { SmtpMailSender } from "./smtp";
import { PostmarkMailSender, SuppressingMailSender } from "./postmark";
import { lazyPlatformSuppressionStore } from "./platform-suppression";

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

/**
 * Process-wide sender: Postmark (preferred) or SMTP when configured and not in mock mode,
 * wrapped so known-bounced/complained addresses are refused; otherwise the MOCK console sender.
 */
export function getMailSender(): MailSender {
  sender ??= (() => {
    if (process.env.WOS_MOCK_MODE === "1") return new ConsoleMailSender();
    const base = PostmarkMailSender.fromEnv() ?? SmtpMailSender.fromEnv();
    return base ? new SuppressingMailSender(base, lazyPlatformSuppressionStore()) : new ConsoleMailSender();
  })();
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
