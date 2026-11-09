import { notifyPrefs } from "@wos/core";
import { ActionForm } from "../../../../actions";
import { orgContext } from "@/server/org-context";
import { Card, inputCls, PageTitle } from "../../../../ui";

export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId, isManager } = await orgContext(orgId);
  const prefs = await notifyPrefs({ actorUserId: userId, orgId });
  return (
    <div className="flex flex-col gap-8">
      <PageTitle sub="Quiet hours and a daily cap. Urgent money or a customer waiting can still surface. Nothing is sent from this screen.">Notifications</PageTitle>
      <Card title="Quiet hours">
        <p className="text-base">Quiet from {prefs.quietStart}:00 to {prefs.quietEnd}:00. At most {prefs.cap} alerts a day, then the rest wait for the morning brief.</p>
        {isManager && (
          <div className="mt-6">
            <ActionForm path="kimi.notifySave" fixed={{ orgId }} submitLabel="Save notification settings">
              <label htmlFor="quiet-start" className="text-base">Quiet starts (hour, 0–23)</label>
              <input id="quiet-start" name="quietStart" type="number" min={0} max={23} required defaultValue={prefs.quietStart} className={inputCls} />
              <label htmlFor="quiet-end" className="text-base">Quiet ends (hour, 0–23)</label>
              <input id="quiet-end" name="quietEnd" type="number" min={0} max={23} required defaultValue={prefs.quietEnd} className={inputCls} />
              <label htmlFor="daily-cap" className="text-base">Daily cap</label>
              <input id="daily-cap" name="cap" type="number" min={1} max={20} required defaultValue={prefs.cap} className={inputCls} />
            </ActionForm>
          </div>
        )}
      </Card>
    </div>
  );
}
