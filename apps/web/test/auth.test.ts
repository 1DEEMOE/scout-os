import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@wos/db";
import { ConsoleMailSender, setMailSenderForTests } from "@wos/core";
import { getAuth, getSessionUserId } from "../src/server/auth";
import { ownerQuery, resetDb } from "../../../packages/db/test/helpers";

// Exercises the real auth library against Postgres: sign-up persists a user,
// the password is hashed, and a session token resolves back to that user.
// Password reset uses the MOCK console mailer only (no real delivery).

let mail: ConsoleMailSender;

beforeEach(async () => {
  await resetDb();
  mail = new ConsoleMailSender();
  setMailSenderForTests(mail);
});

afterAll(async () => {
  await closePool();
});

describe("email and password auth", () => {
  it("signs up, stores a hashed password, and resolves the session", async () => {
    const res = await getAuth().api.signUpEmail({
      body: { name: "Dana", email: "Dana@Example.test", password: "correct horse battery" },
      asResponse: true,
    });
    expect(res.status).toBe(200);

    const [user] = await ownerQuery<{ id: string; email: string }>("SELECT id, email FROM users");
    expect(user?.email).toBe("dana@example.test");

    const [acct] = await ownerQuery<{ password: string }>("SELECT password FROM auth_accounts WHERE user_id = $1", [user!.id]);
    expect(acct?.password).toBeTruthy();
    expect(acct?.password).not.toContain("correct horse battery");

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("better-auth.session_token");
    const headers = new Headers({ cookie: cookie.split(";")[0]! });
    expect(await getSessionUserId(headers)).toBe(user!.id);
  });

  it("rejects short passwords and wrong passwords", async () => {
    await expect(
      getAuth().api.signUpEmail({ body: { name: "E", email: "e@example.test", password: "short" } }),
    ).rejects.toBeTruthy();
    await getAuth().api.signUpEmail({ body: { name: "F", email: "f@example.test", password: "a long enough password" } });
    await expect(
      getAuth().api.signInEmail({ body: { email: "f@example.test", password: "the wrong password" } }),
    ).rejects.toBeTruthy();
  });

  it("returns no user for a missing or forged session cookie", async () => {
    expect(await getSessionUserId(new Headers())).toBeNull();
    expect(await getSessionUserId(new Headers({ cookie: "better-auth.session_token=forged.value" }))).toBeNull();
  });
});

describe("password reset", () => {
  const PASSWORD = "original password long";
  const NEXT = "replacement password long";

  async function signUp(email: string) {
    await getAuth().api.signUpEmail({ body: { name: "Pat", email, password: PASSWORD } });
  }

  function tokenFromMail(): string {
    expect(mail.sent).toHaveLength(1);
    expect(mail.mock).toBe(true);
    const text = mail.sent[0]!.text;
    // Better Auth puts the raw token in the path; we never log the body in production.
    const m = text.match(/\/reset-password\/([A-Za-z0-9_-]+)/);
    expect(m?.[1], "reset token in mock mail").toBeTruthy();
    return m![1]!;
  }

  it("does not reveal whether an email has an account", async () => {
    await signUp("known@example.test");
    mail.sent.length = 0;
    const known = await getAuth().api.requestPasswordReset({ body: { email: "known@example.test", redirectTo: "/reset-password" } });
    const unknown = await getAuth().api.requestPasswordReset({ body: { email: "nobody@example.test", redirectTo: "/reset-password" } });
    expect(known).toMatchObject({ status: true });
    expect(unknown).toMatchObject({ status: true });
    expect(known.message).toBe(unknown.message);
    // Only the known address gets a mock email.
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("known@example.test");
  });

  it("stores a verification row that expires, resets with the token, and refuses reuse", async () => {
    await signUp("reset@example.test");
    mail.sent.length = 0;
    await getAuth().api.requestPasswordReset({ body: { email: "reset@example.test", redirectTo: "/reset-password" } });
    const token = tokenFromMail();

    const rows = await ownerQuery<{ identifier: string; value: string; expires_at: Date }>(
      "SELECT identifier, value, expires_at FROM auth_verifications WHERE identifier LIKE 'reset-password:%'",
    );
    expect(rows).toHaveLength(1);
    // Identifier holds the library token key; the password itself stays hashed in auth_accounts.
    expect(rows[0]!.identifier).toBe(`reset-password:${token}`);
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);

    const [before] = await ownerQuery<{ password: string }>(
      "SELECT password FROM auth_accounts WHERE user_id = (SELECT id FROM users WHERE email = 'reset@example.test')",
    );
    await getAuth().api.resetPassword({ body: { newPassword: NEXT, token } });
    const [after] = await ownerQuery<{ password: string }>(
      "SELECT password FROM auth_accounts WHERE user_id = (SELECT id FROM users WHERE email = 'reset@example.test')",
    );
    expect(after!.password).not.toBe(before!.password);
    expect(after!.password).not.toContain(NEXT);

    // Single-use: the verification row is consumed.
    const left = await ownerQuery("SELECT 1 FROM auth_verifications WHERE identifier = $1", [`reset-password:${token}`]);
    expect(left).toHaveLength(0);
    await expect(getAuth().api.resetPassword({ body: { newPassword: "another password xx", token } })).rejects.toBeTruthy();

    // New password works; old one does not.
    await expect(getAuth().api.signInEmail({ body: { email: "reset@example.test", password: PASSWORD } })).rejects.toBeTruthy();
    const signed = await getAuth().api.signInEmail({ body: { email: "reset@example.test", password: NEXT } });
    expect(signed.user.email).toBe("reset@example.test");
  });

  it("rejects an expired reset token", async () => {
    await signUp("stale@example.test");
    mail.sent.length = 0;
    await getAuth().api.requestPasswordReset({ body: { email: "stale@example.test", redirectTo: "/reset-password" } });
    const token = tokenFromMail();
    await ownerQuery("UPDATE auth_verifications SET expires_at = now() - interval '1 minute' WHERE identifier = $1", [
      `reset-password:${token}`,
    ]);
    await expect(getAuth().api.resetPassword({ body: { newPassword: NEXT, token } })).rejects.toBeTruthy();
  });
});
