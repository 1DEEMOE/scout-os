import type { ModelRouter } from "./router";
import type { ToolRegistry } from "./tools";
import type { MailboxResolver } from "../inbox/mailbox";
import type { CrmResolver } from "../crm/resolver";
import type { InvoicingResolver } from "../finance/resolver";

/** Process-wide dependencies of the engine. Set once at startup (or per test). */
export interface Engine {
  router: ModelRouter;
  tools: ToolRegistry;
  /** How the inbox finds a tenant's mailbox. Absent means no mail integration. */
  mailbox?: MailboxResolver;
  crm?: CrmResolver;
  invoicing?: InvoicingResolver;
  /** How long an approval stays valid. Default 24 hours. */
  approvalTtlMs?: number;
  /** First retry delay in seconds; doubles per attempt. Default 5. */
  retryBaseSeconds?: number;
  now?: () => Date;
}

let engine: Engine | undefined;

export function configureEngine(e: Engine): void {
  engine = e;
}

export function getEngine(): Engine {
  if (!engine) throw new Error("engine not configured: call configureEngine() at startup");
  return engine;
}

export const now = () => (engine?.now ?? (() => new Date()))();
