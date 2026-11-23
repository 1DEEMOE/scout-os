/**
 * Data-subject rights registry (export + erasure). Keyed by SQL table name.
 * A guard test fails if a tenant-scoped table exists that is not classified here,
 * so a new table cannot silently escape export or deletion.
 *
 * Retention choices marked `legalReview: "pending"` are drafting defaults, not legal advice.
 */
export type ErasePolicy = "delete" | "retain";

export interface TablePolicy {
  erase: ErasePolicy;
  /** Columns never included in an export (secrets and credentials). */
  secretColumns?: string[];
  reason?: string;
  legalReview?: "pending";
}

const del: TablePolicy = { erase: "delete" };

export const TABLE_POLICY: Readonly<Record<string, TablePolicy>> = {
  // Credentials: exported without secrets; deleted on erasure.
  integration_connections: { erase: "delete", secretColumns: ["secret_ref", "secret_ciphertext"] },
  payment_destinations: { erase: "delete", secretColumns: ["ciphertext"] },
  front_desk_channels: { erase: "delete", secretColumns: ["token_hash"] },
  // Compliance records that must outlive an erasure request.
  suppression_list: { erase: "retain", reason: "Opt-out and bounce records must persist so deleted contacts are never mailed again (CAN-SPAM/TCPA).", legalReview: "pending" },
  communication_permissions: { erase: "retain", reason: "Proof of consent and revocation history.", legalReview: "pending" },
  billing_ledger: { erase: "retain", reason: "Financial records of what the workspace was charged.", legalReview: "pending" },
  subscriptions: { erase: "retain", reason: "Financial records of what the workspace was charged.", legalReview: "pending" },
  audit_events: { erase: "retain", reason: "Security audit trail. Retention period is an owner/legal decision.", legalReview: "pending" },
  // Everything else is the tenant's data and is deleted.
  organization_members: del, organization_invitations: del, agents: del, agent_versions: del, agent_permissions: del,
  tasks: del, task_dependencies: del, workflow_executions: del, approval_requests: del, email_identities: del,
  conversations: del, messages: del, contacts: del, crm_records: del, invoices: del, memory_records: del,
  usage_events: del, usage_counters: del, chat_threads: del, chat_messages: del, chat_delegations: del,
  business_profiles: del, intelligence_sources: del, signal_observations: del, prospects: del, opportunities: del,
  opportunity_events: del, outreach_events: del, routines: del, routine_runs: del, routine_recoveries: del,
  payment_detail_changes: del, front_desk_slots: del, front_desk_bookings: del, front_desk_rate_buckets: del,
  ai_answer_checks: del, job_photos: del, incoming_documents: del,
  // Adopted 0020-0023: tenant business data and operational telemetry, all deleted on erasure.
  service_menu_items: del, bookable_resources: del, appointments: del, response_templates: del,
  integration_events: del, dead_letters: del, integration_breakers: del, pilot_metrics: del,
};

/**
 * Deletion order for tables with policy "delete": every table appears before any table it
 * references. Foreign keys live in packages/db/migrations (not in the drizzle schema), so a
 * test re-derives the constraints from the SQL and fails if this list drifts.
 * Requires one pre-step: agents.current_version_id must be NULLed first (agents <-> agent_versions cycle).
 */
export const ERASURE_ORDER: readonly string[] = [
  "appointments", "agent_permissions", "agent_versions", "ai_answer_checks", "business_profiles", "chat_delegations", "crm_records",
  "front_desk_bookings", "front_desk_rate_buckets", "incoming_documents", "invoices", "job_photos", "memory_records",
  "messages", "opportunity_events", "organization_invitations", "organization_members", "outreach_events",
  "payment_detail_changes", "routine_recoveries", "routine_runs", "signal_observations", "task_dependencies",
  "usage_counters", "usage_events", "workflow_executions", "approval_requests", "chat_messages", "conversations",
  "front_desk_slots", "opportunities", "payment_destinations", "routines", "chat_threads", "email_identities",
  "front_desk_channels", "prospects", "tasks", "agents", "contacts", "integration_connections", "intelligence_sources",
  "service_menu_items", "bookable_resources", "response_templates", "integration_events", "dead_letters",
  "integration_breakers", "pilot_metrics",
];

export const ERASURE_PRE_STEPS: readonly string[] = ["UPDATE agents SET current_version_id = NULL for the tenant (breaks the agents/agent_versions cycle)"];

/** Findings from reading migrations 0001-0019. Each needs an owner decision before erasure can run. */
export const ERASURE_BLOCKERS: readonly string[] = [
  "audit_events (retained) references approval_requests with no ON DELETE action, so approval_requests cannot be deleted while audit events are kept. Decide: retain approval_requests too, or change that FK to SET NULL (needs reviewed SQL).",
  "Every tenant table cascades from organizations. Deleting the organizations row would also wipe the retained tables (opt-outs, billing, audit). Keep the organizations row (anonymize it) and delete child tables individually.",
  "The app database role is least-privilege and lacks DELETE on at least organizations and audit_events (see migration 0001). Erasure needs a separate, owner-approved privileged path or a reviewed grant. Verify per table.",
];
