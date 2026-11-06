import { notFound } from "next/navigation";
import { orgContext } from "@/server/org-context";

export const dynamic = "force-dynamic";

// Scout data (prospects, contact details, opportunities) is staff-only in the
// core, so viewers get a 404 here instead of a server error from the core check.
export default async function ScoutLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org } = await orgContext(orgId);
  if (org.role === "viewer") notFound();
  return children;
}
