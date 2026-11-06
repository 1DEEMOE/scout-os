"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, quietButtonCls } from "./ui";

/** Mutations a button may trigger. Anything else is refused on the client and the server. */
const ACTIONS = [
  "approval.decide", "approval.confirm", "agent.provisionRecommended", "task.create",
  "inbox.sync", "inbox.triage", "inbox.requestSend", "inbox.setMode",
  "crm.qualifyLead", "crm.connectHubSpot", "finance.sync", "finance.chaseOverdue", "finance.connectStripe", "finance.recordPaymentCallback", "memory.add", "memory.forget", "billing.setBudget", "billing.checkout",
  "chat.createThread", "chat.send", "agent.setPaused", "task.retry", "task.cancel",
  "org.removeMember", "org.setMemberRole", "org.revokeInvitation", "integration.disconnect",
  "scout.reviewProfile", "scout.scan", "scout.engage", "scout.disqualify", "scout.handoff",
  "scout.recordPermission", "scout.revokePermission", "scout.suppress",
  "routines.pause", "routines.resume", "routines.runNow", "routines.recoverLost",
  "gaps2.frontDeskEnable", "gaps2.frontDeskAddSlots", "gaps2.frontDeskSetStatus", "gaps2.aiAnswersRun", "gaps2.jobPhotoUpload", "gaps2.documentAnalyze",
] as const;
export type ActionPath = (typeof ACTIONS)[number];

async function call(path: ActionPath, input: unknown): Promise<unknown> {
  if (!ACTIONS.includes(path)) throw new Error("Unknown action");
  const [ns, fn] = path.split(".") as [string, string];
  const proc = (trpc as unknown as Record<string, Record<string, { mutate: (i: unknown) => Promise<unknown> }>>)[ns]![fn]!;
  return proc.mutate(input);
}

function useAction(path: ActionPath) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(input: unknown, after?: (r: unknown) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await call(path, input);
      after?.(r);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function ActionButton(props: {
  path: ActionPath;
  input: unknown;
  label: string;
  busyLabel?: string;
  variant?: "primary" | "quiet" | "danger";
  confirm?: string;
  redirectToTask?: { orgId: string };
}) {
  const router = useRouter();
  const { busy, error, run } = useAction(props.path);
  const cls = props.variant === "primary" ? buttonCls : props.variant === "danger" ? quietButtonCls.replace("border-line", "border-danger/50 text-danger") : quietButtonCls;
  return (
    <span className="inline-flex flex-col gap-1 self-start">
      <button
        type="button"
        disabled={busy}
        className={cls}
        onClick={() => {
          if (props.confirm && !window.confirm(props.confirm)) return;
          void run(props.input, (r) => {
            const taskId = (r as { taskId?: string | null } | undefined)?.taskId;
            if (props.redirectToTask && taskId) router.push(`/orgs/${props.redirectToTask.orgId}/tasks/${taskId}`);
            const url = (r as { url?: string } | undefined)?.url;
            if (url?.startsWith("https://checkout.stripe.com/")) window.location.assign(url);
          });
        }}
      >
        {busy ? (props.busyLabel ?? "Working…") : props.label}
      </button>
      <ErrorText message={error} />
    </span>
  );
}

/** A small form whose fields become the mutation input (merged with `fixed`). */
export function ActionForm(props: {
  path: ActionPath;
  fixed: Record<string, unknown>;
  submitLabel: string;
  children: React.ReactNode;
  redirectToTask?: { orgId: string };
  /** After success, open the chat thread the mutation returned. */
  redirectToThread?: { orgId: string };
  /** Send a fresh client reference with each submit, so a double click is stored once. */
  clientRef?: boolean;
  resetOnSuccess?: boolean;
  /** Secondary forms (e.g. "Rule out") use a quiet button so the main action stands out. */
  quiet?: boolean;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction(props.path);
  const [done, setDone] = useState(false);
  return (
    <form
      className="flex flex-col gap-3"
      action={async (form: FormData) => {
        setDone(false);
        const fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
        const ref = props.clientRef ? { clientRef: crypto.randomUUID() } : {};
        await run({ ...props.fixed, ...fields, ...ref }, (r) => {
          setDone(true);
          const out = r as { taskId?: string | null; threadId?: string } | undefined;
          if (props.redirectToTask && out?.taskId) router.push(`/orgs/${props.redirectToTask.orgId}/tasks/${out.taskId}`);
          if (props.redirectToThread && out?.threadId) router.push(`/orgs/${props.redirectToThread.orgId}/chat/${out.threadId}`);
        });
      }}
    >
      {props.children}
      <ErrorText message={error} />
      {done && !error && !props.resetOnSuccess && <p className="text-sm text-accent">Done.</p>}
      <button disabled={busy} className={`${props.quiet ? quietButtonCls : buttonCls} self-start`}>
        {busy ? "Working…" : props.submitLabel}
      </button>
    </form>
  );
}
