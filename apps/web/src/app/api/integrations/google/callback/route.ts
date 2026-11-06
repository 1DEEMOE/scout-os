import { NextResponse, type NextRequest } from "next/server";
import { AppError, connectGoogleMailbox, exchangeGoogleCode, logger } from "@wos/core";
import { getSessionUserId } from "@/server/auth";
import { ensureEngine } from "@/server/engine";
import { verifyState } from "@/server/oauth-state";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const userId = await getSessionUserId(req.headers);
  if (!userId) return NextResponse.redirect(new URL("/sign-in", url));
  const state = verifyState(url.searchParams.get("state") ?? "", req.cookies.get("wos_oauth_nonce")?.value, userId);
  if (!state) return new NextResponse("This connection link is invalid or expired. Start again from Settings.", { status: 400 });
  const back = new URL(`/orgs/${state.orgId}/settings`, url);
  const code = url.searchParams.get("code");
  if (!code) {
    back.searchParams.set("error", "Google access was not granted.");
    return NextResponse.redirect(back);
  }
  try {
    ensureEngine();
    const { tokens, address, scopes } = await exchangeGoogleCode(code, new URL("/api/integrations/google/callback", url).toString());
    await connectGoogleMailbox({ actorUserId: userId, orgId: state.orgId, address, tokens, scopes });
    back.searchParams.set("connected", address);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), orgId: state.orgId }, "google connect failed");
    back.searchParams.set("error", err instanceof AppError ? err.message : "Connecting Google failed. Please try again.");
  }
  const res = NextResponse.redirect(back);
  res.cookies.delete({ name: "wos_oauth_nonce", path: "/api/integrations/google" });
  return res;
}
