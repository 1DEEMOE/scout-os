import type { SessionUser } from "./auth";

/**
 * Platform admins (Darian, the operator) can create client workspaces.
 * Configured outside the database so no tenant data can grant it:
 *   WOS_PLATFORM_ADMIN_USER_IDS  comma-separated user ids (preferred), or
 *   WOS_PLATFORM_ADMIN_EMAILS    comma-separated emails; only honoured once that
 *                                email is verified, so signing up with someone
 *                                else's address never grants it.
 * Unset (the default) means nobody is a platform admin.
 */
function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(user: Pick<SessionUser, "id" | "email" | "emailVerified"> | null): boolean {
  if (!user) return false;
  if (list("WOS_PLATFORM_ADMIN_USER_IDS").includes(user.id.toLowerCase())) return true;
  return user.emailVerified && list("WOS_PLATFORM_ADMIN_EMAILS").includes(user.email.toLowerCase());
}
