import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations, withTenant } from "@wos/db";
import { renderEstimateText } from "../industries/elite";
import { getMailSender } from "../mail/sender";
import { recordAudit } from "../audit";
import { ToolError, type ToolDefinition, type ToolRegistry } from "../engine/tools";
import { jobForSend, markEstimateSent } from "../jobs/service";

/**
 * jobs.send_estimate: the ONLY path that turns a drafted estimate into an
 * email to a customer. It exists so the approvals engine can hold the send:
 * a manager clicks "send" on the job, an approval request is created at the
 * pack's compliance floor, and only after a person approves does the executor
 * run this tool.
 *
 * The tool re-validates everything at execution time — the approval may be
 * hours old, and the job or pricing config may have changed under it. A job
 * whose estimate gained a blocker in the meantime fails closed instead of
 * sending. Mock mode sends through the console sender and is labelled MOCK.
 */

export const JOBS_SEND_ESTIMATE_TOOL = "jobs.send_estimate";

const argsSchema = z.object({ jobId: z.string().max(64) });

export function jobsTools(): ToolDefinition[] {
  const send: ToolDefinition<z.infer<typeof argsSchema>, { sent: boolean; mock: boolean; jobId: string }> = {
    name: JOBS_SEND_ESTIMATE_TOOL,
    description:
      "Email a prepared job estimate to the customer, with the pack's required disclosures. " +
      "Always approval-gated (tier 2+); re-validates the estimate at send time and fails closed if it became blocked.",
    tier: 2,
    args: argsSchema,
    output: z.object({ sent: z.boolean(), mock: z.boolean(), jobId: z.string() }),
    rate: { limit: 30, windowMs: 60 * 60 * 1000 },
    summarize: (a) => `Send the estimate for job ${a.jobId.slice(0, 8)} to the customer`,
    mock: true, // sending is MOCK whenever the platform sender is not configured; the UI badge comes from getMailSender().mock at render time
    async execute(ctx, a) {
      return withTenant(ctx.tenantId, async (tx) => {
        const { job, pack, estimate } = await jobForSend(tx, ctx.tenantId, a.jobId);
        if (!job.customerEmail) throw new ToolError("The job has no customer email.", false, "VALIDATION");
        if (estimate.blockedReasons.length) {
          throw new ToolError(`Estimate is blocked and cannot be sent: ${estimate.blockedReasons.join(" ")}`, false, "VALIDATION");
        }
        if (job.status !== "approval_pending" && job.status !== "estimate_sent") {
          throw new ToolError(`Job is "${job.status}", not waiting on an estimate approval.`, false, "CONFLICT");
        }

        const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.tenantId));
        const text = renderEstimateText(pack, estimate, {
          business: org?.name ?? "Your service provider",
          customer: job.customerName,
          jurisdiction: job.jurisdiction,
        });

        const sender = getMailSender();
        const { already } = await markEstimateSent(tx, ctx.tenantId, job.id);
        if (already) return { sent: true, mock: sender.mock, jobId: job.id }; // crash-retry: the mail already went out

        await sender.send({
          to: job.customerEmail,
          subject: `${estimate.kind === "binding" ? "Binding estimate" : "Estimate"} from ${org?.name ?? "your service provider"}`,
          text,
        });
        await recordAudit(tx, {
          tenantId: ctx.tenantId, actorType: "agent", actorId: ctx.agentId,
          action: "job.estimate_sent", target: `job:${job.id}`, tier: 2, outcome: "success",
          metadata: { totalCents: estimate.totalCents, kind: estimate.kind, mock: sender.mock }, // recipient address stays out of the audit log (PII)
        });
        return { sent: true, mock: sender.mock, jobId: job.id };
      });
    },
  };
  return [send] as ToolDefinition[];
}

export function registerJobsTools(registry: ToolRegistry): void {
  registry.register(...jobsTools());
}
