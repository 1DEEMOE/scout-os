import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { getAuthPool } from "@wos/db";
import { getMailSender, logger } from "@wos/core";
import { BRAND } from "../brand";

const ts = { createdAt: "created_at", updatedAt: "updated_at" } as const;

async function deliver(to: string, subject: string, text: string): Promise<void> {
  // Mail failures must not break auth flows: the user can resend from the UI.
  try {
    await getMailSender().send({ to, subject, text });
  } catch (err) {
    logger.warn({ err, subject }, "auth email delivery failed");
  }
}

/**
 * "Continue with Google" for people accepting an invite. Opt-in with
 * WOS_GOOGLE_SIGNIN=1 and the same Google OAuth client as the Gmail
 * integration (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET); the client must list
 * <BETTER_AUTH_URL>/api/auth/callback/google as a redirect URI. Off by default.
 * Live sign-in is UNVERIFIED until tested against a real Google client.
 */
export function googleSignInEnabled(): boolean {
  return process.env.WOS_GOOGLE_SIGNIN === "1" && !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

function build() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  return betterAuth({
    database: getAuthPool(),
    secret,
    baseURL: process.env.BETTER_AUTH_URL,
    ...(googleSignInEnabled()
      ? { socialProviders: { google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! } } }
      : {}),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      autoSignIn: true,
      // Off by default so existing deployments don't strand unverified users;
      // set WOS_REQUIRE_EMAIL_VERIFICATION=1 to enforce.
      requireEmailVerification: process.env.WOS_REQUIRE_EMAIL_VERIFICATION === "1",
      sendResetPassword: async ({ user, url }) => {
        await deliver(
          user.email,
          `Reset your ${BRAND.name} password`,
          `A password reset was requested for your ${BRAND.name} account.\n\nReset your password: ${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore it — your password is unchanged.`,
        );
      },
    },
    emailVerification: {
      sendOnSignUp: process.env.WOS_REQUIRE_EMAIL_VERIFICATION === "1",
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await deliver(
          user.email,
          `Verify your ${BRAND.name} email`,
          `Welcome to ${BRAND.name}.\n\nVerify your email address: ${url}\n\nThis link expires in 1 hour.`,
        );
      },
    },
    // Database-backed so limits hold across restarts and multiple replicas.
    // The rate_limits table is global (no tenant), created in migration 0015.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rate_limits",
      fields: { lastRequest: "last_request" },
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 10 },
        "/request-password-reset": { window: 300, max: 5 },
        "/reset-password": { window: 300, max: 10 },
        "/send-verification-email": { window: 300, max: 5 },
      },
    },
    // Map the library's models onto our snake_case tables (migrations/0001_init.sql).
    user: { modelName: "users", fields: { emailVerified: "email_verified", ...ts } },
    session: {
      modelName: "auth_sessions",
      fields: { userId: "user_id", expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent", ...ts },
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...ts,
      },
    },
    verification: { modelName: "auth_verifications", fields: { expiresAt: "expires_at", ...ts } },
    plugins: [nextCookies()],
  });
}

let instance: ReturnType<typeof build> | undefined;

/** Created on first use so builds don't need database credentials. */
export function getAuth() {
  instance ??= build();
  return instance;
}

export async function getSessionUserId(headers: Headers): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers });
  return session?.user.id ?? null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;
  const u = session.user;
  return { id: u.id, name: u.name ?? "", email: u.email, emailVerified: Boolean(u.emailVerified) };
}
