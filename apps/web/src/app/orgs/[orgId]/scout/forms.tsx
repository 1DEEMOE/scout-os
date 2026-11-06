"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls } from "../../../ui";

type Profile = {
  website: string | null;
  services: string[];
  idealCustomer: string;
  serviceArea: { states: string[]; counties: { state: string; county: string }[]; center: { lat: number; lon: number } | null };
  settings: { radiusMiles?: number; lookbackDays?: number; minScore?: number; retentionDays?: number; monthlyDataCostCents?: number; averageJobValueCents?: number };
};

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      after?.(r);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, go };
}

const fileCls = "text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-ink hover:file:bg-line/40";
const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const dollarsToCents = (s: string) => (s.trim() === "" ? undefined : Math.round(Number(s) * 100));

/** Business profile. Saving returns it to draft; a manager reviews it separately. */
export function ProfileForm({ orgId, profile, suggestedServices, canEdit }: { orgId: string; profile: Profile | null; suggestedServices: string[]; canEdit: boolean }) {
  const { busy, error, go } = useSubmit();
  const [saved, setSaved] = useState(false);
  const s = profile?.settings ?? {};
  const counties = profile?.serviceArea.counties.map((c) => `${c.county}, ${c.state}`).join("\n") ?? "";
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        const f = new FormData(e.currentTarget);
        const get = (k: string) => String(f.get(k) ?? "");
        // One county per line, "County, ST": split on the last comma.
        const countyRows = get("counties").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
          const i = l.lastIndexOf(",");
          return i < 0 ? { county: l, state: "" } : { county: l.slice(0, i).trim(), state: l.slice(i + 1).trim().toUpperCase() };
        });
        const num = (k: string) => (get(k).trim() === "" ? undefined : Number(get(k)));
        const settings = Object.fromEntries(Object.entries({
          radiusMiles: num("radiusMiles"), lookbackDays: num("lookbackDays"), minScore: num("minScore"), retentionDays: num("retentionDays"),
          monthlyDataCostCents: dollarsToCents(get("monthlyDataCost")), averageJobValueCents: dollarsToCents(get("averageJobValue")),
        }).filter(([, v]) => v !== undefined));
        void go(() => trpc.scout.saveProfile.mutate({
          orgId,
          profile: {
            vertical: "roofing", website: get("website"), services: lines(get("services")), idealCustomer: get("idealCustomer"),
            serviceArea: { states: lines(get("states")).map((x) => x.toUpperCase()), counties: countyRows, center: null }, settings,
          },
        }), () => setSaved(true));
      }}
    >
      <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Industry
          <input value="Residential roofing" readOnly className={`${inputCls} text-muted`} aria-describedby="vertical-note" />
          <span id="vertical-note" className="text-xs text-muted">Roofing is the first industry Scout supports.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">Website (optional)
          <input name="website" type="url" defaultValue={profile?.website ?? ""} placeholder="https://" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-sm">States you serve
          <input name="states" defaultValue={profile?.serviceArea.states.join(", ") ?? ""} placeholder="TX, OK" className={inputCls} />
          <span className="text-xs text-muted">Two-letter codes. Leave empty if you list counties instead.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">Counties you serve
          <textarea name="counties" rows={3} defaultValue={counties} placeholder={"Dallas, TX\nCollin, TX"} className={inputCls} />
          <span className="text-xs text-muted">One per line: county, state.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">Services
          <textarea name="services" rows={4} defaultValue={(profile?.services.length ? profile.services : suggestedServices).join("\n")} className={inputCls} />
          {!profile && <span className="text-xs text-muted">Suggested for roofing. Nothing is used until you save and review.</span>}
        </label>
        <label className="flex flex-col gap-1 text-sm">Ideal customer
          <textarea name="idealCustomer" rows={4} defaultValue={profile?.idealCustomer ?? ""} placeholder="Homeowners with roofs over 10 years old" className={inputCls} />
        </label>
      </fieldset>
      <details className="rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Matching rules and your numbers</summary>
        <fieldset disabled={!canEdit} className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">Radius (miles)<input name="radiusMiles" type="number" min={1} max={50} defaultValue={s.radiusMiles ?? 10} className={inputCls} /></label>
          <label className="flex flex-col gap-1 text-sm">Look back (days)<input name="lookbackDays" type="number" min={1} max={365} defaultValue={s.lookbackDays ?? 30} className={inputCls} /></label>
          <label className="flex flex-col gap-1 text-sm">Minimum score<input name="minScore" type="number" min={0} max={100} defaultValue={s.minScore ?? 30} className={inputCls} /></label>
          <label className="flex flex-col gap-1 text-sm">Keep prospect records (days)<input name="retentionDays" type="number" min={30} max={1095} defaultValue={s.retentionDays ?? 365} className={inputCls} /></label>
          <label className="flex flex-col gap-1 text-sm">Monthly data/list cost ($)<input name="monthlyDataCost" type="number" min={0} step="0.01" defaultValue={s.monthlyDataCostCents !== undefined ? s.monthlyDataCostCents / 100 : ""} className={inputCls} /></label>
          <label className="flex flex-col gap-1 text-sm">Average job value ($)<input name="averageJobValue" type="number" min={0} step="1" defaultValue={s.averageJobValueCents !== undefined ? s.averageJobValueCents / 100 : ""} className={inputCls} /></label>
        </fieldset>
        <p className="mt-2 text-xs text-muted">The two dollar figures are yours. Analytics labels anything calculated from them as Customer-reported or Estimated.</p>
      </details>
      <ErrorText message={error} />
      {saved && !error && <p role="status" className="text-sm text-accent">Saved as a draft. Review it below before Scout uses it.</p>}
      {canEdit && <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Saving…" : "Save profile"}</button>}
    </form>
  );
}

async function readFile(input: HTMLInputElement): Promise<{ text: string; name: string } | null> {
  const file = input.files?.[0];
  if (!file) return null;
  if (file.size > 2_000_000) throw new Error("That file is over 2 MB.");
  return { text: await file.text(), name: file.name };
}

export function StormUploadForm({ orgId }: { orgId: string }) {
  const { busy, error, go } = useSubmit();
  const [result, setResult] = useState<{ reportDay: string; added: number; duplicates: number; rejected: { line: number; reason: string }[] } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setResult(null);
        setFileError(null);
        const form = e.currentTarget;
        let file;
        try {
          file = await readFile(form.elements.namedItem("file") as HTMLInputElement);
        } catch (err) {
          return setFileError((err as Error).message);
        }
        if (!file) return setFileError("Choose a CSV file.");
        const reportDay = String(new FormData(form).get("reportDay") ?? "") || undefined;
        void go(() => trpc.scout.uploadSignals.mutate({ orgId, csv: file.text, filename: file.name, reportDay }), setResult);
      }}
    >
      <label className="flex flex-col gap-1 text-sm">SPC storm report CSV
        <input name="file" type="file" accept=".csv,text/csv" required className={fileCls} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Report day (if the file name doesn&apos;t include it)
        <input name="reportDay" type="date" className={`${inputCls} w-48`} />
      </label>
      <ErrorText message={fileError ?? error} />
      {result && (
        <p role="status" className="text-sm">
          {result.reportDay}: added {result.added}, already had {result.duplicates}
          {result.rejected.length > 0 && <>, couldn&apos;t read {result.rejected.length} (first: line {result.rejected[0]!.line}, {result.rejected[0]!.reason})</>}.
        </p>
      )}
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Uploading…" : "Upload storm reports"}</button>
    </form>
  );
}

export function ProspectImportForm({ orgId }: { orgId: string }) {
  const { busy, error, go } = useSubmit();
  const [result, setResult] = useState<{ added: number; duplicates: number; rejected: { line: number; reason: string }[]; droppedColumns: string[] } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setResult(null);
        setFileError(null);
        const form = e.currentTarget;
        let file;
        try {
          file = await readFile(form.elements.namedItem("file") as HTMLInputElement);
        } catch (err) {
          return setFileError((err as Error).message);
        }
        if (!file) return setFileError("Choose a CSV file.");
        const f = new FormData(form);
        void go(() => trpc.scout.importProspects.mutate({ orgId, csv: file.text, label: String(f.get("label") ?? ""), usageRights: String(f.get("usageRights") ?? ""), attest: f.get("attest") === "on" }), (r) => {
          setResult(r);
          form.reset();
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">CSV file
        <input name="file" type="file" accept=".csv,text/csv" required className={fileCls} />
        <span className="text-xs text-muted">Columns used: name, email, phone, address, city, county, state, zip, lat, lon. Any other column is ignored and not stored.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">Name for this list
        <input name="label" required maxLength={200} placeholder="Past customers 2019–2025" className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Where it came from, and your right to use it
        <textarea name="usageRights" required minLength={10} rows={2} placeholder="Our own customers from past jobs." className={inputCls} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input name="attest" type="checkbox" required className="mt-1" />
        <span>I confirm we have the right to use this list for this purpose. Having someone&apos;s contact details doesn&apos;t mean they agreed to be contacted; Scout won&apos;t email anyone without a recorded permission.</span>
      </label>
      <ErrorText message={fileError ?? error} />
      {result && (
        <p role="status" className="text-sm">
          Added {result.added}, already had {result.duplicates}
          {result.rejected.length > 0 && <>, skipped {result.rejected.length} (first: line {result.rejected[0]!.line}, {result.rejected[0]!.reason})</>}
          {result.droppedColumns.length > 0 && <>. Ignored columns: {result.droppedColumns.join(", ")}</>}.
        </p>
      )}
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Importing…" : "Import prospects"}</button>
    </form>
  );
}

export function QualifyForm({ orgId, opportunityId, questions }: { orgId: string; opportunityId: string; questions: { id: string; question: string }[] }) {
  const { busy, error, go } = useSubmit();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const answers = Object.fromEntries(questions.map((q) => [q.id, String(f.get(q.id) ?? "")]));
        void go(() => trpc.scout.qualify.mutate({ orgId, opportunityId, answers, note: String(f.get("note") ?? "") }));
      }}
    >
      {questions.map((q) => (
        <label key={q.id} className="flex flex-col gap-1 text-sm">{q.question}
          <input name={q.id} required maxLength={500} className={inputCls} />
        </label>
      ))}
      <label className="flex flex-col gap-1 text-sm">Note (optional)
        <textarea name="note" rows={2} maxLength={1000} className={inputCls} />
      </label>
      <ErrorText message={error} />
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Saving…" : "Mark qualified"}</button>
    </form>
  );
}
