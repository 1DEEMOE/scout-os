"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { Badge, buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../ui";

type Industry = "roofing" | "general";
type LeadField = "fullName" | "email" | "phone" | "addressLine1" | "city" | "state" | "postalCode" | "county" | "notes" | "ignore";

type State = {
  orgId: string;
  orgName: string;
  industry: Industry | null;
  timezone: string | null;
  step: string | null;
  completedAt: string | null;
  plan: string;
  checklist: Array<{ id: string; label: string; done: boolean; href?: string }>;
  hasDemoData: boolean;
  hasMorningBriefing: boolean;
  hasBriefingRun: boolean;
  serviceAreaSummary: string | null;
};

type Step = "industry" | "basics" | "data" | "connect" | "invite" | "finish";

const STEPS: Step[] = ["industry", "basics", "data", "connect", "invite", "finish"];

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

function initialStep(s: State): Step {
  if (!s.industry) return "industry";
  if (!s.timezone) return "basics";
  if (s.step && STEPS.includes(s.step as Step)) return s.step as Step;
  return "basics";
}

export function SetupWizard({ orgId, initial }: { orgId: string; initial: State }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [step, setStep] = useState<Step>(initialStep(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // basics
  const [name, setName] = useState(initial.orgName || "");
  const [timezone, setTimezone] = useState(initial.timezone || detectTimezone());
  const [zip, setZip] = useState("");
  const [county, setCounty] = useState("");
  const [st, setSt] = useState("");

  // csv
  const [csvText, setCsvText] = useState("");
  const [mapping, setMapping] = useState<Record<string, LeadField> | null>(null);
  const [preview, setPreview] = useState<Array<Record<string, string>>>([]);
  const [missingRequired, setMissingRequired] = useState<LeadField[]>([]);

  // invite
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  const stepIndex = STEPS.indexOf(step);

  async function run<T>(fn: () => Promise<T>, next?: Step): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "checklist" in (r as object)) setState(r as unknown as State);
      if (next) setStep(next);
      router.refresh();
      return r;
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const connectors = useMemo(
    () => [
      { id: "gmail", label: "Gmail", note: "Inbox triage & draft replies" },
      { id: "hubspot", label: "HubSpot", note: "Pipeline sync" },
      { id: "stripe", label: "Stripe", note: "Invoices & payments" },
      { id: "quickbooks", label: "QuickBooks", note: "Coming soon — placeholder" },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li key={s}>
            <span className={`rounded border px-2 py-1 ${i === stepIndex ? "border-accent text-accent" : i < stepIndex ? "border-line text-muted line-through" : "border-line text-muted"}`}>
              {i + 1}. {s}
            </span>
          </li>
        ))}
      </ol>

      {step === "industry" && (
        <section className="flex flex-col gap-3 rounded-md border border-line p-4">
          <h2 className="font-semibold">What kind of business is this?</h2>
          <p className="text-sm text-muted">Picks agent defaults, the Morning Briefing, and plan entitlements. Approval rules stay the same.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-line p-4 text-left hover:border-accent"
              onClick={() => void run(() => trpc.onboarding.chooseIndustry.mutate({ orgId, industry: "roofing" }), "basics")}
            >
              <div className="font-medium">Roofing</div>
              <p className="mt-1 text-sm text-muted">Storm leads → inbox → pipeline → billing. Starts a Scout Pro trial.</p>
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-line p-4 text-left hover:border-accent"
              onClick={() => void run(() => trpc.onboarding.chooseIndustry.mutate({ orgId, industry: "general" }), "basics")}
            >
              <div className="font-medium">General SMB</div>
              <p className="mt-1 text-sm text-muted">Inbox, pipeline, follow-up and billing for any small team. Growth trial.</p>
            </button>
          </div>
        </section>
      )}

      {step === "basics" && (
        <section className="flex flex-col gap-3 rounded-md border border-line p-4">
          <h2 className="font-semibold">Business basics</h2>
          <p className="text-sm text-muted">Only these fields are required. Everything else can wait.</p>
          <label className="flex flex-col gap-1 text-sm">
            Business name
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Time zone
            <input className={inputCls} value={timezone} onChange={(e) => setTimezone(e.target.value)} maxLength={64} />
            <span className="text-xs text-muted">Auto-detected from this browser. IANA name, e.g. America/New_York.</span>
          </label>
          {state.industry === "roofing" && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                Service-area ZIP
                <input className={inputCls} value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" maxLength={10} placeholder="80202" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  County (if ZIP unknown)
                  <input className={inputCls} value={county} onChange={(e) => setCounty(e.target.value)} maxLength={100} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  State
                  <input className={inputCls} value={st} onChange={(e) => setSt(e.target.value.toUpperCase())} maxLength={2} placeholder="CO" />
                </label>
              </div>
            </>
          )}
          <button
            type="button"
            disabled={busy || !name.trim()}
            className={`${buttonCls} self-start`}
            onClick={() =>
              void run(
                () =>
                  trpc.onboarding.saveBasics.mutate({
                    orgId,
                    name,
                    timezone,
                    ...(zip ? { zip } : {}),
                    ...(county ? { county } : {}),
                    ...(st ? { state: st } : {}),
                  }),
                "data",
              )
            }
          >
            {busy ? "Saving…" : "Continue"}
          </button>
        </section>
      )}

      {step === "data" && (
        <section className="flex flex-col gap-4 rounded-md border border-line p-4">
          <h2 className="font-semibold">Get to first value</h2>
          {state.industry === "roofing" && (
            <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/5 p-3">
              <div className="flex items-center gap-2">
                <Badge tone="warn">DEMO</Badge>
                <span className="text-sm font-medium">One-click sample data</span>
              </div>
              <p className="text-sm text-muted">
                Loads invented homeowners (@example.test) and synthetic storm reports labelled (DEMO). Removable with one click. Not real people.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={buttonCls}
                  onClick={() => void run(async () => { await trpc.onboarding.loadDemo.mutate({ orgId }); return trpc.onboarding.state.query({ orgId }); }, "connect")}
                >
                  {busy ? "Loading…" : "Load DEMO sample"}
                </button>
                {state.hasDemoData && (
                  <button
                    type="button"
                    disabled={busy}
                    className={quietButtonCls}
                    onClick={() => void run(async () => { await trpc.onboarding.clearDemo.mutate({ orgId }); return trpc.onboarding.state.query({ orgId }); })}
                  >
                    Remove DEMO data
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Or import your own leads (CSV)</h3>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void f.text().then(async (text) => {
                  setCsvText(text);
                  const r = await run(() => trpc.onboarding.previewCsv.mutate({ orgId, csv: text }));
                  if (r) {
                    setMapping(r.mapping as Record<string, LeadField>);
                    setPreview(r.previewRows);
                    setMissingRequired(r.missingRequired as LeadField[]);
                  }
                });
              }}
            />
            {mapping && (
              <div className="flex flex-col gap-2 text-sm">
                <p className="text-muted">Column mapping (edit if needed):</p>
                {Object.entries(mapping).map(([header, field]) => (
                  <label key={header} className="flex items-center gap-2">
                    <span className="w-40 truncate text-muted">{header}</span>
                    <select
                      className={inputCls}
                      value={field}
                      onChange={(e) => setMapping({ ...mapping, [header]: e.target.value as LeadField })}
                    >
                      {(["fullName", "email", "phone", "addressLine1", "city", "state", "postalCode", "county", "notes", "ignore"] as LeadField[]).map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                ))}
                {missingRequired.length > 0 && <p className="text-danger">Need a name column before importing.</p>}
                {preview.length > 0 && (
                  <div className="overflow-x-auto rounded border border-line p-2 text-xs">
                    <pre>{JSON.stringify(preview, null, 2)}</pre>
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy || !mapping || missingRequired.length > 0}
                  className={`${buttonCls} self-start`}
                  onClick={() =>
                    void run(async () => {
                      await trpc.onboarding.importCsv.mutate({ orgId, csv: csvText, mapping: mapping! });
                      return trpc.onboarding.state.query({ orgId });
                    }, "connect")
                  }
                >
                  Import leads
                </button>
              </div>
            )}
          </div>

          <button type="button" disabled={busy} className={`${quietButtonCls} self-start`} onClick={() => void run(() => trpc.onboarding.skipData.mutate({ orgId }), "connect")}>
            Skip for now
          </button>
        </section>
      )}

      {step === "connect" && (
        <section className="flex flex-col gap-3 rounded-md border border-line p-4">
          <h2 className="font-semibold">Connect tools later</h2>
          <p className="text-sm text-muted">Nothing is connected now. No live sign-in from this screen — you can wire these up from Settings when ready.</p>
          <ul className="divide-y divide-line text-sm">
            {connectors.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <div className="font-medium">{c.label}</div>
                  <div className="text-muted">{c.note}</div>
                </div>
                <Badge>connect later</Badge>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            className={`${buttonCls} self-start`}
            onClick={() => void run(() => trpc.onboarding.connectLater.mutate({ orgId, skipped: connectors.map((c) => c.id) }), "invite")}
          >
            Continue
          </button>
        </section>
      )}

      {step === "invite" && (
        <section className="flex flex-col gap-3 rounded-md border border-line p-4">
          <h2 className="font-semibold">Invite your crew (optional)</h2>
          <p className="text-sm text-muted">They need an account first. Roles keep approval rules intact — viewers can&apos;t approve.</p>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input className={inputCls} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} type="email" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role
            <select className={inputCls} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !inviteEmail}
              className={buttonCls}
              onClick={() =>
                void run(async () => {
                  await trpc.onboarding.invite.mutate({ orgId, email: inviteEmail, role: inviteRole });
                  setInviteEmail("");
                  return trpc.onboarding.state.query({ orgId });
                })
              }
            >
              Invite
            </button>
            <button type="button" disabled={busy} className={quietButtonCls} onClick={() => void run(() => trpc.onboarding.skipInvite.mutate({ orgId }), "finish")}>
              Skip
            </button>
          </div>
          {state.step === "invite" && (
            <button type="button" disabled={busy} className={`${buttonCls} self-start`} onClick={() => setStep("finish")}>
              Continue to finish
            </button>
          )}
        </section>
      )}

      {step === "finish" && (
        <section className="flex flex-col gap-3 rounded-md border border-line p-4">
          <h2 className="font-semibold">Generate your first Morning Briefing</h2>
          <p className="text-sm text-muted">
            Creates a daily 7:00 local briefing routine and runs it once inside the app. Nothing is emailed or texted.
          </p>
          <ul className="text-sm text-muted list-disc pl-5">
            {state.checklist.map((c) => (
              <li key={c.id} className={c.done ? "text-accent" : ""}>
                {c.done ? "✓" : "○"} {c.label}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            className={`${buttonCls} self-start`}
            onClick={() =>
              void run(async () => {
                const r = await trpc.onboarding.finish.mutate({ orgId });
                router.push(`/orgs/${orgId}/routines/briefing`);
                return r as unknown as State;
              })
            }
          >
            {busy ? "Generating…" : "Finish & open briefing"}
          </button>
        </section>
      )}

      <ErrorText message={error} />
    </div>
  );
}
