export type AppErrorCode = "VALIDATION" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "UPGRADE_REQUIRED" | "QUOTA_EXCEEDED";

/** Typed error surfaced to callers. `message` is safe to show in the UI. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
