import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed OAuth `state`: binds the callback to the user and org that started
 * it, expires after 10 minutes, and must match an httpOnly cookie, so a link
 * from someone else can't attach their mailbox to your org (login CSRF).
 */
export interface OAuthState {
  orgId: string;
  userId: string;
  nonce: string;
  exp: number;
}

function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("BETTER_AUTH_SECRET is not set");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(`oauth-state:${payload}`).digest("base64url");

export function createState(orgId: string, userId: string, now = Date.now()): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ orgId, userId, nonce, exp: now + 10 * 60 * 1000 } satisfies OAuthState)).toString("base64url");
  return { state: `${payload}.${sign(payload)}`, nonce };
}

export function verifyState(state: string, cookieNonce: string | undefined, userId: string, now = Date.now()): OAuthState | null {
  const [payload, mac] = state.split(".");
  if (!payload || !mac || !cookieNonce) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let s: OAuthState;
  try {
    s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
  } catch {
    return null;
  }
  if (s.exp < now || s.userId !== userId || s.nonce !== cookieNonce) return null;
  return s;
}
