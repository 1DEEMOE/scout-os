import { getPauseState, listIntegrations, listInvitations, listMailboxes, listMembers } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton, ActionForm } from "../../../actions";
import { Badge, Card, Empty, inputCls, PageTitle, quietButtonCls, When } from "../../../ui";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ connected?: string; error?: string }> }) {
  const { orgId } = await params;
  const q = await searchParams;
  const { userId, isManager, isOwner } = await orgContext(orgId);
  const [members, integrations, mailboxes, pause, invitations] = await Promise.all([
    listMembers({ actorUserId: userId, orgId }),
    listIntegrations({ actorUserId: userId, orgId }),
    listMailboxes({ actorUserId: userId, orgId }),
    getPauseState({ actorUserId: userId, orgId }),
    isManager ? listInvitations({ actorUserId: userId, orgId }) : Promise.resolve([]),
  ]);
  const has = (p: string) => integrations.some((i) => i.provider === p && i.status === "active");

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>Settings</PageTitle>
      {q.connected && <p role="status" className="text-sm text-accent">Connected {q.connected}.</p>}
      {q.error && <p role="alert" className="text-sm text-danger">{q.error}</p>}

      <section id="agents">
        <Card title="Agent switch">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              {pause.paused ? (
                <>
                  <strong className="text-danger">Paused</strong> by {pause.pausedByName} · <When date={pause.pausedAt} />. Approvals can still be decided; nothing runs until agents are resumed.
                </>
              ) : (
                <>
                  <strong className="text-accent">Running.</strong> Pausing stops every agent before its next action and stops the lead bot handing off work.
                </>
              )}
            </p>
            {isOwner ? (
              pause.paused ? (
                <ActionButton path="agent.setPaused" input={{ orgId, paused: false }} label="Resume agents" variant="primary" />
              ) : (
                <ActionButton path="agent.setPaused" input={{ orgId, paused: true }} label="Pause all agents" variant="danger" confirm="Pause every agent in this organization?" />
              )
            ) : (
              <span className="text-xs text-muted">Only an owner can pause or resume agents.</span>
            )}
          </div>
        </Card>
      </section>

      <Card title="Members">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full text-left text-sm">
          <tbody>
            {members.map((m) => {
              const isStaffRow = m.role === "owner" || m.role === "admin";
              const canManage = isManager && m.userId !== userId && (!isStaffRow || isOwner);
              return (
                <tr key={m.userId} className="border-b border-line">
                  <td className="py-2">{m.name}{m.userId === userId && <span className="ml-1 text-xs text-muted">(you)</span>}</td>
                  <td className="py-2">{m.email}</td>
                  <td className="py-2">
                    {canManage ? (
                      <ActionForm path="org.setMemberRole" fixed={{ orgId, userId: m.userId }} submitLabel="Change role">
                        <div className="flex items-center gap-2">
                          <select name="role" defaultValue={m.role} className={`${inputCls} w-32`}>
                            {isOwner && <option value="owner">Owner</option>}
                            {isOwner && <option value="admin">Admin</option>}
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        </div>
                      </ActionForm>
                    ) : (
                      <span className="capitalize">{m.role}</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {canManage && (
                      <ActionButton path="org.removeMember" input={{ orgId, userId: m.userId }} label="Remove" variant="danger" confirm={`Remove ${m.name} from the organization?`} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </Card>
      {isManager && <InviteForm orgId={orgId} canGrantOwner={isOwner} />}
      {isManager && invitations.length > 0 && (
        <Card title="Invitations">
          <ul className="divide-y divide-line text-sm">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{inv.email} · <span className="capitalize">{inv.role}</span></span>
                <span className="flex items-center gap-2">
                  <Badge tone={inv.status === "pending" ? "warn" : inv.status === "accepted" ? "accent" : "muted"}>{inv.status}</Badge>
                  {inv.status === "pending" && <span className="text-xs text-muted">expires <When date={inv.expiresAt} /></span>}
                  {inv.status === "pending" && (
                    <ActionButton path="org.revokeInvitation" input={{ orgId, invitationId: inv.id }} label="Revoke" confirm={`Revoke the invitation for ${inv.email}?`} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Connected apps">
        {integrations.length === 0 ? <div className="mb-4"><Empty>Nothing connected yet.</Empty></div> : (
          <ul className="mb-4 divide-y divide-line text-sm">
            {integrations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-medium capitalize">{i.provider}</span> · {i.accountLabel}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={i.status === "active" ? "accent" : "danger"}>{i.status}</Badge>
                  <span className="text-xs text-muted">updated <When date={i.updatedAt} /></span>
                  {isManager && (
                    <ActionButton path="integration.disconnect" input={{ orgId, connectionId: i.id }} label="Disconnect" variant="danger" confirm={`Disconnect ${i.provider} (${i.accountLabel})? Agents lose access immediately and any mailbox sync stops.`} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {mailboxes.map((b) => (
          <div key={b.id} className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-line p-3 text-sm">
            <span>Mailbox {b.address}: <strong>{b.mode === "draft_only" ? "draft-only" : "sending allowed with approval"}</strong></span>
            {isOwner && (b.mode === "draft_only"
              ? <ActionButton path="inbox.setMode" input={{ orgId, identityId: b.id, mode: "send_with_approval" }} label="Allow sending (each send still needs approval)" confirm="Let agents send email from this mailbox after a person approves each one?" />
              : <ActionButton path="inbox.setMode" input={{ orgId, identityId: b.id, mode: "draft_only" }} label="Back to draft-only" />)}
          </div>
        ))}
        {isManager && (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="mb-2 text-sm font-medium">Google mailbox (Gmail)</h3>
              <a className={quietButtonCls} href={`/api/integrations/google/start?orgId=${orgId}`}>{has("google") ? "Reconnect Google" : "Connect Google"}</a>
              <p className="mt-1 text-xs text-muted">Read and draft access. Starts in draft-only mode.</p>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">HubSpot</h3>
              <ActionForm path="crm.connectHubSpot" fixed={{ orgId, label: "HubSpot portal" }} submitLabel={has("hubspot") ? "Replace token" : "Connect HubSpot"}>
                <input name="accessToken" type="password" required autoComplete="off" placeholder="Private app access token" className={inputCls} />
              </ActionForm>
            </div>
            {isOwner && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Stripe (owners only)</h3>
                <ActionForm path="finance.connectStripe" fixed={{ orgId }} submitLabel={has("stripe") ? "Replace key" : "Connect Stripe"}>
                  <input name="secretKey" type="password" required autoComplete="off" placeholder="sk_test_… or a restricted key" className={inputCls} />
                </ActionForm>
                <p className="mt-1 text-xs text-muted">Use a test-mode or restricted key. Keys are encrypted and never shown again.</p>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
