import { getLeadFormSettings, listFrontDeskChannels, listFrontDeskSlots, listPendingFrontDeskBookings, managedNumberStatus } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../../actions";
import { Badge, Card, Empty, PageTitle, When } from "../../../../ui";
import { AddSlots, EnableDesk, RotateLink } from "./desk-client";
import { LeadFormCard } from "./lead-form-card";
import { ManagedNumber } from "./managed-number";

export const dynamic = "force-dynamic";

function fmt(d: Date, tz: string) {
  return d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function FrontDeskPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager, isOwner, org } = await orgContext(orgId);
  const isViewer = org.role === "viewer";
  const orgName = org.name;
  const channels = await listFrontDeskChannels({ actorUserId: userId, orgId });
  const ch = channels[0];
  const slots = ch ? await listFrontDeskSlots({ actorUserId: userId, orgId, channelId: ch.id }) : [];
  const pending = ch ? await listPendingFrontDeskBookings({ actorUserId: userId, orgId }) : [];
  const numberStatus = isManager ? await managedNumberStatus({ actorUserId: userId, orgId }) : null;
  const leadForm = ch ? await getLeadFormSettings({ actorUserId: userId, orgId }) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle sub="A booking link for your website, texts or Google profile. People and AI assistants can request a time; nothing is confirmed until someone here approves it.">
        Front desk
      </PageTitle>

      {!ch ? (
        <Card title="Set up your booking link">
          {isManager ? <EnableDesk orgId={orgId} defaultName={orgName ?? ""} /> : <p className="text-sm text-muted">An owner or admin can create the booking link.</p>}
        </Card>
      ) : (
        <>
          <Card
            title={<span className="flex flex-wrap items-center gap-2">{ch.displayName} <Badge tone={ch.status === "active" ? "accent" : "warn"}>{ch.status === "active" ? "taking requests" : "paused"}</Badge></span>}
            actions={
              isManager && (
                <ActionButton
                  path="gaps2.frontDeskSetStatus"
                  input={{ orgId, channelId: ch.id, paused: ch.status === "active" }}
                  label={ch.status === "active" ? "Pause" : "Resume"}
                />
              )
            }
          >
            <div className="flex flex-col gap-3 text-sm">
              <p>
                Time zone: <strong>{ch.timezone}</strong>. {ch.status === "paused" ? "While paused, the link shows \"not found\" and takes no requests." : "Every request lands in Needs your OK as a booking to approve or decline."}
              </p>
              <p className="text-muted">What customers are told: &ldquo;{ch.disclosure}&rdquo;</p>
              {isManager && <RotateLink orgId={orgId} channelId={ch.id} />}
            </div>
          </Card>

          <Card title={<span className="flex items-center gap-2">Waiting for your OK {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}</span>}>
            {pending.length === 0 ? (
              <Empty>No booking requests waiting.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {pending.map((b) => (
                  <li key={b.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      <strong>{b.customerName}</strong> {b.requesterKind === "ai_agent" && <Badge>via AI assistant{b.agentName ? `: ${b.agentName}` : ""}</Badge>}
                    </span>
                    <span className="flex items-center gap-3 text-muted">
                      <When date={b.createdAt} />
                      <a className="underline" href={`/orgs/${orgId}/approvals`}>Review</a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Lead form for your website">
            {leadForm?.channel ? (
              isManager ? (
                <LeadFormCard
                  orgId={orgId}
                  channelId={leadForm.channel.id}
                  initial={{
                    enabled: leadForm.form.enabled,
                    intro: leadForm.form.intro,
                    successMessage: leadForm.form.successMessage,
                    askPhone: leadForm.form.askPhone,
                    askCompany: leadForm.form.askCompany,
                    askMessage: leadForm.form.askMessage,
                  }}
                />
              ) : (
                <p className="text-sm text-muted">The lead form is {leadForm.form.enabled ? "on" : "off"}. An owner or admin can change it.</p>
              )
            ) : (
              <Empty>Set up the booking link above first — the lead form shares it.</Empty>
            )}
          </Card>

          <Card title="Upcoming time slots">
            {!isViewer && <div className="mb-4"><AddSlots orgId={orgId} channelId={ch.id} deskTimezone={ch.timezone} /></div>}
            {slots.length === 0 ? (
              <Empty>No open times yet, so the booking link has nothing to offer. Add a few above.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {slots.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                    <span>{fmt(s.startsAt, ch.timezone)} – {s.endsAt.toLocaleTimeString("en-US", { timeZone: ch.timezone, hour: "numeric", minute: "2-digit" })}</span>
                    <span className="tabular-nums text-muted">{s.reservedCount} of {s.capacity} requested</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card title="Business phone number">
        <p className="mb-3 text-sm text-muted">
          A number the platform sets up for you: it answers missed calls with your recording disclosure and takes a message, and can send one text-back. No Twilio account needed.
        </p>
        {numberStatus ? (
          <ManagedNumber orgId={orgId} isOwner={isOwner} initial={numberStatus} />
        ) : (
          <p className="text-sm text-muted">An owner or admin can manage the business number.</p>
        )}
      </Card>
    </div>
  );
}
