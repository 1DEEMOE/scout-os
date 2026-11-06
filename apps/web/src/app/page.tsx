import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const userId = await getSessionUserId(await headers());
  redirect(userId ? "/orgs" : "/sign-in");
}
