import { NextResponse } from "next/server";
import { googleAuthUrl, listMyOrgs } from "@wos/core";
import { getSessionUserId } from "@/server/auth";
import { createState } from "@/server/oauth-state";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await getSessionUserId(req.headers);
  const url = new URL(req.url);
  if (!userId) return NextResponse.redirect(new URL("/sign-in", url));
  const orgId = url.searchParams.get("orgId") ?? "";
  const me = (await listMyOrgs({ actorUserId: userId })).find((o) => o.orgId === orgId);
  if (!me || (me.role !== "owner" && me.role !== "admin")) return new NextResponse("Not found", { status: 404 });
  if (!process.env.GOOGLE_CLIENT_ID) return new NextResponse("Google integration is not configured on this server.", { status: 501 });

  const { state, nonce } = createState(orgId, userId);
  const res = NextResponse.redirect(googleAuthUrl(new URL("/api/integrations/google/callback", url).toString(), state));
  res.cookies.set("wos_oauth_nonce", nonce, { httpOnly: true, secure: url.protocol === "https:", sameSite: "lax", maxAge: 600, path: "/api/integrations/google" });
  return res;
}
