import { listFrontDeskChannels, listFrontDeskSlots, listPendingFrontDeskBookings } from "@wos/core";
import { orgContext } from "@/server/org-context";
import { ActionButton } from "../../../../actions";
import { Badge, Card, Empty, PageTitle, When } from "../../../../ui";
import { AddSlots, EnableDesk, RotateLink } from "./desk-client";

export const dynamic = "force-dynamic";

function fmt(d: Date, tz: string) {
  return d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function FrontDeskPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager, org } = await orgContext(orgId);
  const isViewer = org.role === "viewer";
  const orgName = org.name;
  const channels = await listFrontDeskChannels({ actorUserId: userId, orgId });
  const ch = channels[0];
  const [slots, pending] = ch
    ? await Promise.all([listFrontDeskSlots({ actorUserId: userId, orgId, channelId: ch.id }), listPendingFrontDeskBookings({ actorUserId: userId, orgId })])
    : [[], []];

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
    </div>
  );
}
