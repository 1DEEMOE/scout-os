import { AppError, listArtifacts, readArtifactByToken, scrubPii } from "@wos/core";
import { ActionForm } from "../../../actions";
import { orgContext } from "@/server/org-context";
import { Card, Empty, inputCls, PageTitle } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function LibraryPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ token?: string }> }) {
  const { orgId } = await params;
  const { token } = await searchParams;
  const { userId, org } = await orgContext(orgId);
  const artifacts = await listArtifacts({ actorUserId: userId, orgId });
  let opened: { title: string } | null = null;
  let expired = false;
  if (token) {
    try {
      opened = await readArtifactByToken({ actorUserId: userId, orgId, token });
    } catch (err) {
      if (err instanceof AppError && err.code === "NOT_FOUND") expired = true;
      else throw err;
    }
  }
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Notes you asked Scout to keep. Each link expires after a week.">Library</PageTitle>
      {opened && <p role="status" className="text-base text-accent">Opened “{shown(opened.title)}”. The link is still good.</p>}
      {expired && <p role="alert" className="text-base text-danger">That link has expired.</p>}
      <Card title="Saved notes">
        {artifacts.length === 0 ? <Empty>Nothing saved yet.</Empty> : (
          <ul className="flex flex-col gap-3">
            {artifacts.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 rounded-2xl border border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-lg">{shown(item.title)}</span>
                <a className="text-base text-accent underline" href={`/orgs/${orgId}/library?token=${item.token}`}>Open · expires {item.expiresAt.slice(0, 10)}</a>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {org.role !== "viewer" && (
        <Card title="Save a note">
          <ActionForm path="kimi.artifact" fixed={{ orgId }} submitLabel="Save">
            <label htmlFor="artifact-title" className="text-base">Name</label>
            <input id="artifact-title" name="title" required maxLength={120} placeholder="Weekly note" className={inputCls} />
          </ActionForm>
        </Card>
      )}
    </div>
  );
}

function shown(value: string): string {
  const clean = scrubPii(value);
  return typeof clean === "string" && clean.trim() ? clean : "Untitled";
}
