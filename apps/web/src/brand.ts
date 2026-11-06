/**
 * Customer-facing identity. Change the product name here only.
 *
 * Internal identifiers keep their original "wos" / "Workforce OS" names on
 * purpose (packages @wos/*, env WOS_*, database roles, HubSpot property
 * wos_idempotency_key, email Message-IDs): renaming them would break running
 * installs and references stored at providers. See docs/design/scout-architecture.md §2.
 */
export const BRAND = {
  name: "Scout OS",
  tagline: "Your AI workforce. Finding opportunities. Running operations.",
  promise: "Scout OS helps businesses discover opportunities, manage customer relationships, coordinate work, and get paid.",
} as const;

/** Directive roster names for each agent kind (display only; kinds are unchanged). */
export const AGENT_ROLE_NAME: Record<string, string> = {
  scout: "Scout",
  inbox: "Inbox",
  sales: "Pipeline",
  finance: "Billing",
  orchestrator: "Coordinator",
  reporting: "Analyst",
  scheduling: "Scheduling",
};
