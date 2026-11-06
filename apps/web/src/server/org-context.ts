import { notFound } from "next/navigation";
import { listMyOrgs, type MyOrg } from "@wos/core";
import { ensureEngine } from "./engine";
import { requireUserId } from "./session";

/** For org pages: the signed-in user and their membership, or a 404. */
export async function orgContext(orgId: string): Promise<{ userId: string; org: MyOrg; isManager: boolean; isOwner: boolean }> {
  ensureEngine();
  const userId = await requireUserId();
  const org = (await listMyOrgs({ actorUserId: userId })).find((o) => o.orgId === orgId);
  if (!org) notFound();
  return { userId, org, isManager: org.role === "owner" || org.role === "admin", isOwner: org.role === "owner" };
}
