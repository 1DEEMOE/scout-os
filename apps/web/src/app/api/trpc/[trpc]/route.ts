import { randomUUID } from "node:crypto";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { correlation, sameOrigin } from "@wos/core";
import { appRouter } from "@/server/root";
import { getSessionUserId } from "@/server/auth";
import { makeContext } from "@/server/trpc";

export const dynamic = "force-dynamic";

function handler(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return new Response("Cross-site request blocked", { status: 403 });
  }
  const id = req.headers.get("x-request-id")?.slice(0, 80) || randomUUID();
  return correlation.run({ id }, () =>
    fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router: appRouter,
      createContext: async () => makeContext(await getSessionUserId(req.headers)),
    }),
  );
}

export { handler as GET, handler as POST };
