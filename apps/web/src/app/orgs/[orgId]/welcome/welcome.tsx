"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../ui";
import { minutesText, QUICKSTART_STEPS } from "./progress";

type Industry = "roofing" | "general";
const label = "flex flex-col gap-2 text-base font-medium";

function Progress({ step }: { step: 1 | 2 | 3 }) {
  const s = QUICKSTART_STEPS[step - 1]!;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">Step {step} of 3</span>
        <span className="text-muted">{minutesText(s.minutesLeft)}</span>
      </p>
      <div role="progressbar" aria-label="Setup" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step} aria-valuetext={`Step ${step} of 3, ${minutesText(s.minutesLeft)}`} className="flex gap-2">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${n <= step ? "bg-accent" : "bg-soft"}`} />
        ))}
      </div>
    </div>
  );
}

export function Welcome(props: {
  orgId: string;
  step: 1 | 2 | 3;
  name: string;
  industry: Industry;
  zip: string;
  serviceArea: string | null;
  hasDemoData: boolean;
  emailConnectAvailable: boolean;
  emailConnected: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(props.step);
  const [industry, setIndustry] = useState<Industry>(props.industry);
  const [timezone, setTimezone] = useState("America/New_York");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) setTimezone(tz);
  }, []);
  useEffect(() => {
    // Move focus to the new step's heading so screen readers hear the change.
    document.getElementById("welcome-step")?.focus();
  }, [step]);

  async function run(fn: () => Promise<unknown>, next: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      next();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const finish = (hour: number, samples: boolean) =>
    run(
      () => trpc.onboarding.finishQuickstart.mutate({ orgId: props.orgId, briefingHour: hour, samples: samples && industry === "roofing", timezone }),
      () => {
        router.push(`/orgs/${props.orgId}?welcome=1`);
        router.refresh();
      },
    );

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-10">
      <header className="flex flex-col gap-6">
        <div>
          <p className="text-muted">Welcome to Scout OS</p>
          <p className="mt-1 text-xl font-semibold">{props.name}</p>
        </div>
        <Progress step={step} />
      </header>

      {step === 1 && (
        <form action={(f) => run(
          () => trpc.onboarding.quickstartBusiness.mutate({
            orgId: props.orgId,
            name: String(f.get("name") ?? ""),
            industry,
            timezone,
            ...(industry === "roofing" && String(f.get("zip") ?? "").trim() ? { zip: String(f.get("zip")).trim() } : {}),
          }),
          () => {
            setStep(2);
            router.refresh(); // pick up the service area for step 3
          },
        )} className="flex flex-col gap-7">
          <h1 id="welcome-step" tabIndex={-1} className="text-display font-semibold outline-none">Your business</h1>
          <label className={label}>
            Business name
            <input name="name" defaultValue={props.name} required maxLength={120} className={inputCls} />
          </label>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-base font-medium">Trade</legend>
            {([["roofing", "Roofing", "Storm reports and nearby prospects, scored for you"], ["general", "Other small business", "Leads, follow-ups, invoices and approvals"]] as const).map(([value, title, note]) => (
              <label key={value} className={`flex min-h-14 cursor-pointer items-center gap-4 rounded-2xl border px-5 py-3 transition-colors duration-150 ${industry === value ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-soft"}`}>
                <input type="radio" name="industry" value={value} checked={industry === value} onChange={() => setIndustry(value)} className="h-5 w-5 accent-[var(--color-accent)]" />
                <span className="flex flex-col">
                  <span className="font-medium">{title}</span>
                  <span className="text-small text-muted">{note}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {industry === "roofing" && (
            <label className={label}>
              Service-area ZIP <span className="font-normal text-muted">(where Scout watches for storms)</span>
              <input name="zip" defaultValue={props.zip} inputMode="numeric" maxLength={10} placeholder="30303" className={inputCls} />
            </label>
          )}
          <p className="text-small text-muted">Time zone: {timezone}, from this device.</p>
          <ErrorText message={error} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy} className={buttonCls}>{busy ? "Saving…" : "Continue"}</button>
            <button type="button" disabled={busy} className={quietButtonCls} onClick={() => setStep(2)}>Skip</button>
          </div>
        </form>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-7">
          <h1 id="welcome-step" tabIndex={-1} className="text-display font-semibold outline-none">Connect your email</h1>
          <p className="text-lg text-muted">Scout reads new leads and drafts replies for you. Nothing is sent until you OK it.</p>
          {props.emailConnected ? (
            <p role="status" className="rounded-2xl border border-line bg-surface px-5 py-4">Gmail is connected.</p>
          ) : props.emailConnectAvailable ? (
            <a href={`/api/integrations/google/start?orgId=${props.orgId}`} className={`${quietButtonCls} self-start`}>Connect Gmail</a>
          ) : (
            <p className="rounded-2xl border border-line bg-surface px-5 py-4">
              Email connection isn&apos;t switched on for this server yet. You can connect it later from Settings, under Integrations.
            </p>
          )}
          <ErrorText message={error} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} className={props.emailConnected ? buttonCls : quietButtonCls} onClick={() => run(() => trpc.onboarding.quickstartSkipConnect.mutate({ orgId: props.orgId }), () => setStep(3))}>
              {props.emailConnected ? "Continue" : "Skip for now"}
            </button>
            <button type="button" disabled={busy} className="inline-flex min-h-11 items-center px-2 text-muted underline underline-offset-4" onClick={() => setStep(1)}>Back</button>
          </div>
        </section>
      )}

      {step === 3 && (
        <form action={(f) => finish(Number(f.get("hour") ?? 7), f.get("samples") === "on")} className="flex flex-col gap-7">
          <h1 id="welcome-step" tabIndex={-1} className="text-display font-semibold outline-none">What should Scout watch?</h1>
          <p className="text-lg text-muted">
            Each morning Scout puts a short briefing on your Today page{industry === "roofing" ? `: storm reports${props.serviceArea ? ` in ${props.serviceArea}` : ""} and the best prospects,` : ":"} leads waiting for a reply, stalled deals, follow-ups, overdue invoices and anything waiting for your OK.
          </p>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-base font-medium">Briefing time</legend>
            <div className="flex flex-wrap gap-3">
              {[6, 7, 8].map((h) => (
                <label key={h} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-full border border-line bg-surface px-5 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                  <input type="radio" name="hour" value={h} defaultChecked={h === 7} className="h-5 w-5 accent-[var(--color-accent)]" />
                  {h}:00 am
                </label>
              ))}
            </div>
          </fieldset>
          {industry === "roofing" && !props.hasDemoData && (
            <label className="flex min-h-14 cursor-pointer items-start gap-4 rounded-2xl border border-line bg-surface px-5 py-4">
              <input type="checkbox" name="samples" defaultChecked className="mt-1 h-5 w-5 accent-[var(--color-accent)]" />
              <span className="flex flex-col">
                <span className="font-medium">Show me 3 sample opportunities to try right now</span>
                <span className="text-small text-muted">Invented DEMO homeowners and storm reports in your area, clearly labelled. Remove them any time.</span>
              </span>
            </label>
          )}
          <ErrorText message={error} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy} className={buttonCls}>{busy ? "Making your first briefing…" : "Finish and see my briefing"}</button>
            <button type="button" disabled={busy} className={quietButtonCls} onClick={() => finish(7, true)}>Skip</button>
            <button type="button" disabled={busy} className="inline-flex min-h-11 items-center px-2 text-muted underline underline-offset-4" onClick={() => setStep(2)}>Back</button>
          </div>
          <p className="text-small text-muted">Skip uses 7 am and the samples. You can change both later.</p>
        </form>
      )}
    </div>
  );
}
