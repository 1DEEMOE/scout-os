import { logger } from "../logger";

/**
 * Platform email sender (verification, password reset). This is the SaaS's own
 * mail, not a tenant's mailbox — tenant mail goes through the inbox integration.
 *
 * Always the labelled MOCK console sender in this build: logs the message and
 * keeps it in memory for tests. No real delivery (Law 2 / verification constraint).
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
    // Log recipient and subject but not the body: the body holds secrets (tokens).
    logger.info(
      { mail: { to: mail.to, subject: mail.subject, mock: true, ...(process.env.WOS_MAIL_DEBUG_BODY === "1" ? { text: mail.text } : {}) } },
      "MOCK email (console sender): not delivered",
    );
    return { id: `console_${this.sent.length}` };
  }
}

let sender: MailSender | undefined;

/** Process-wide sender. Always MOCK in this build. */
export function getMailSender(): MailSender {
  sender ??= new ConsoleMailSender();
  return sender;
}

/** For tests only. */
export function setMailSenderForTests(s: MailSender): void {
  sender = s;
}
