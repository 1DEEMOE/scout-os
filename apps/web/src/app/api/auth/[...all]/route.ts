import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";
import { withResolvedClientIp } from "@/server/public-api";

export const dynamic = "force-dynamic";

// Every auth request carries our trusted client IP, so sign-in limits are per client, not shared.
export function GET(req: Request) {
  return toNextJsHandler(getAuth()).GET(withResolvedClientIp(req));
}

export function POST(req: Request) {
  return toNextJsHandler(getAuth()).POST(withResolvedClientIp(req));
}
