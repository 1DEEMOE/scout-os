import { listMyOrgs } from "@wos/core";
import { requireUserId } from "@/server/session";
import { CreateOrgForm } from "./create-org-form";
import { SignOutButton } from "../sign-out-button";

export const dynamic = "force-dynamic";

export default async function OrgsPage() {
  const userId = await requireUserId();
  const orgs = await listMyOrgs({ actorUserId: userId });
  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-4 flex items-center justify-between"><h1 className="text-2xl font-semibold">Your organizations</h1><SignOutButton /></div>
        {orgs.length === 0 ? (
          <p className="text-muted">You're not in any organization yet. Create one below.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {orgs.map((o) => (
              <li key={o.orgId}>
                <a href={`/orgs/${o.orgId}`} className="flex items-center justify-between px-4 py-3 hover:bg-line/40">
                  <span className="font-medium">{o.name}</span>
                  <span className="text-xs uppercase tracking-wide text-muted">{o.role}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <CreateOrgForm />
    </div>
  );
}
