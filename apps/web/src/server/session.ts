import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./auth";

/** For server components: returns the signed-in user id or redirects to sign-in. */
export async function requireUserId(): Promise<string> {
  const userId = await getSessionUserId(await headers());
  if (!userId) redirect("/sign-in");
  return userId;
}
