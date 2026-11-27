import { listContacts, listMembers } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { PageTitle } from "../../../../ui";
import { DealForm } from "./deal-form";

export const dynamic = "force-dynamic";

export default async function NewDealPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId } = await orgContext(orgId);
  const [contacts, members] = await Promise.all([
    listContacts({ actorUserId: userId, orgId }),
    listMembers({ actorUserId: userId, orgId }),
  ]);
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="A deal tracks one piece of potential work through your pipeline.">New deal</PageTitle>
      <DealForm
        orgId={orgId}
        contacts={contacts.map((c) => ({ id: c.id, name: c.name, email: c.email }))}
        members={members.map((m) => ({ userId: m.userId, name: m.name }))}
        currentUserId={userId}
      />
    </div>
  );
}
