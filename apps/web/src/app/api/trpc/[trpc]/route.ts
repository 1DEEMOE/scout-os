import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/root";
import { getSessionUserId } from "@/server/auth";
import { makeContext } from "@/server/trpc";

export const dynamic = "force-dynamic";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: async () => makeContext(await getSessionUserId(req.headers)),
  });
}

export { handler as GET, handler as POST };
