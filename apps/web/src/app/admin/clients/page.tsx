import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth";
import { isPlatformAdmin } from "@/server/platform-admin";
import { listPacks } from "@wos/core";
import { ProvisionForm } from "./provision-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Client workspaces" };

/**
 * Operator-only: create a client's workspace and copy one invite link.
 * Anyone else gets a 404 (the page doesn't admit it exists).
 */
export default async function ClientWorkspacesPage() {
  const user = await getSessionUser(await headers());
  if (!user) redirect("/sign-in");
  if (!isPlatformAdmin(user)) notFound();
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-10">
      <header>
        <p className="text-muted">Operator</p>
        <h1 className="mt-1 text-display font-semibold">New client workspace</h1>
        <p className="mt-3 text-lg text-muted">
          Creates the workspace already named and set up for their trade, then gives you one link to send. They set a password and see their first briefing in a few minutes.
        </p>
      </header>
      <ProvisionForm packs={listPacks().map((p) => ({ id: p.id, label: p.label, group: p.group }))} />
      <section className="flex flex-col gap-2 text-muted">
        <h2 className="text-lg font-semibold text-ink">Good to know</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>You don&apos;t become a member, so you can&apos;t see the client&apos;s data afterwards.</li>
          <li>The link works once, only for the email you enter, and expires in 7 days. It&apos;s shown only here, right after you create it.</li>
          <li>Nothing is emailed from here. Send the link yourself.</li>
          <li>A custom accent colour needs migration 0020 (proposed, waiting for review), so for now each workspace is branded with its name and initial.</li>
        </ul>
      </section>
    </div>
  );
}
