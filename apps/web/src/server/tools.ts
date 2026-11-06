import {
  registerCrmTools,
  registerFinanceTools,
  registerFrontDeskTools,
  registerInboxTools,
  registerMemoryTools,
  registerOutreachTools,
  registerScoutTools,
  type CrmResolver,
  type InvoicingResolver,
  type MailboxResolver,
  type ToolRegistry,
} from "@wos/core";

/** Registers the product's real tools. */
export function registerProductTools(registry: ToolRegistry, deps: { mailbox: MailboxResolver; crm: CrmResolver; invoicing: InvoicingResolver }): void {
  registerInboxTools(registry, deps.mailbox);
  registerCrmTools(registry, deps.crm);
  registerFinanceTools(registry, deps.invoicing);
  registerMemoryTools(registry);
  registerScoutTools(registry);
  registerOutreachTools(registry, deps.mailbox);
  registerFrontDeskTools(registry);
}
