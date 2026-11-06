import { eq } from "drizzle-orm";
import { users, withGlobal } from "@wos/db";
import { AppError } from "../errors";
import { logger } from "../logger";

/**
 * Platform admins (the operator, e.g. Darian) can provision client
 * workspaces. Granted only by server configuration, never by tenant data:
 *   WOS_PLATFORM_ADMIN_USER_IDS  comma-separated user ids (preferred), or
 *   WOS_PLATFORM_ADMIN_EMAILS    comma-separated emails, honoured only once
 *                                that email is verified, so signing up with
 *                                someone else's address never grants it.
 * Unset (the default) means nobody is a platform admin.
 */
function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(user: { id: string; email: string; emailVerified: boolean } | null): boolean {
  if (!user) return false;
  if (list("WOS_PLATFORM_ADMIN_USER_IDS").includes(user.id.toLowerCase())) return true;
  return user.emailVerified && list("WOS_PLATFORM_ADMIN_EMAILS").includes(user.email.toLowerCase());
}

/** Re-reads the user from the database (not the session cookie) before any platform action. */
export async function assertPlatformAdmin(userId: string, action: string): Promise<{ id: string; email: string }> {
  const [u] = await withGlobal((tx) => tx.select({ id: users.id, email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId)));
  if (!u || !isPlatformAdmin(u)) {
    logger.warn({ actor: userId, action }, "platform admin check denied");
    // Same answer as a missing page: don't reveal that the admin area exists.
    throw new AppError("NOT_FOUND", "Not found");
  }
  return { id: u.id, email: u.email };
}
