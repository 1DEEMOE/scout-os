import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleMailSender, getMailSender, platformEmailConfigured, setMailSenderForTests, SmtpMailSender } from "../src/index";

describe("SMTP platform email", () => {
  afterEach(() => setMailSenderForTests(new ConsoleMailSender()));

  it("builds a real message with the configured sender address", async () => {
    // Stream transport renders the full RFC 5322 message without a network.
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const sender = new SmtpMailSender(transport, "Scout OS <no-reply@scout.example>");
    const out = await sender.send({ to: "dana@example.test", subject: "Reset your Scout OS password", text: "Reset: https://x/reset?token=abc" });
    expect(out.id).toBeTruthy();
    expect(sender.mock).toBe(false);
  });

  it("is configured only from SMTP_URL + MAIL_FROM, and refuses half a config", () => {
    expect(SmtpMailSender.fromEnv({})).toBeNull();
    expect(() => SmtpMailSender.fromEnv({ SMTP_URL: "smtp://u:p@mail.example:587" })).toThrow(/MAIL_FROM/);
    expect(() => SmtpMailSender.fromEnv({ SMTP_URL: "http://mail.example", MAIL_FROM: "a@b.c" })).toThrow(/smtp:\/\//);
    expect(SmtpMailSender.fromEnv({ SMTP_URL: "smtps://u:p@mail.example:465", MAIL_FROM: "Scout OS <a@b.c>" })).toBeInstanceOf(SmtpMailSender);
  });

  it("screens can tell whether email really goes out", () => {
    setMailSenderForTests(new ConsoleMailSender());
    expect(platformEmailConfigured()).toBe(false);
    setMailSenderForTests(new SmtpMailSender(nodemailer.createTransport({ jsonTransport: true }), "a@b.c"));
    expect(platformEmailConfigured()).toBe(true);
    expect(getMailSender().name).toBe("smtp");
  });
});
