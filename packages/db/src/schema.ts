import { bigint, bigserial, boolean, date, doublePrecision, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Mirrors migrations/*.sql. The SQL files are the source of truth (they also
// hold RLS policies and grants); keep this file in step with them.

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  monthlyAiBudgetMicros: bigint("monthly_ai_budget_micros", { mode: "number" }).notNull().default(5_000_000),
  agentsPausedAt: ts("agents_paused_at"),
  agentsPausedBy: text("agents_paused_by"),
  /** Wizard industry preset: roofing | general. */
  industry: text("industry", { enum: ["roofing", "general"] }),
  timezone: text("timezone"),
  onboardingCompletedAt: ts("onboarding_completed_at"),
  onboardingStep: text("onboarding_step"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const organizationMembers = pgTable(
  "organization_members",
  {
    tenantId: uuid("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  seq: bigserial("seq", { mode: "number" }),
  tenantId: uuid("tenant_id").notNull(),
  actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  tier: smallint("tier").notNull().default(1),
  approvalRequestId: uuid("approval_request_id"),
  idempotencyKey: text("idempotency_key"),
  outcome: text("outcome", { enum: ["success", "denied", "error"] }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  at: ts("at").notNull().defaultNow(),
  // Tamper-evident chain (G4): hash of the previous entry, and this entry's hash.
  // NULL on rows written before migration 0018 (pre-chain history).
  prevHash: text("prev_hash"),
  entryHash: text("entry_hash"),
});

// ---------- Wave 1 hardening: organization invitations ----------

export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const organizationInvitations = pgTable("organization_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ROLES }).notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status", { enum: INVITATION_STATUSES }).notNull().default("pending"),
  invitedBy: text("invited_by").notNull(),
  acceptedBy: text("accepted_by"),
  acceptedAt: ts("accepted_at"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Milestone 2: agents, tasks, approvals ----------

export const AGENT_KINDS = ["orchestrator", "inbox", "sales", "finance", "scheduling", "reporting", "scout"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const TASK_STATES = [
  "REQUESTED", "CLASSIFIED", "PLANNED", "POLICY_CHECKED", "WAITING_FOR_APPROVAL", "ASSIGNED",
  "EXECUTING", "VERIFYING", "COMPLETED", "RETRY_SCHEDULED", "ESCALATED", "FAILED", "COMPENSATING",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const APPROVAL_STATUSES = ["pending", "awaiting_confirmation", "approved", "rejected", "expired", "consumed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind", { enum: AGENT_KINDS }).notNull(),
  displayName: text("display_name").notNull(),
  status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
  currentVersionId: uuid("current_version_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentVersions = pgTable("agent_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  version: integer("version").notNull(),
  modelPolicy: jsonb("model_policy").$type<{ provider?: string; model?: string; maxTokens?: number }>().notNull().default({}),
  instructions: text("instructions").notNull(),
  toolAllowlist: text("tool_allowlist").array().notNull().default([]),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentPermissions = pgTable(
  "agent_permissions",
  {
    tenantId: uuid("tenant_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    toolName: text("tool_name").notNull(),
    integrationConnectionId: uuid("integration_connection_id"),
    maxTier: smallint("max_tier").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.agentId, t.toolName] })],
);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  parentTaskId: uuid("parent_task_id"),
  requestedBy: text("requested_by").notNull(),
  assignedAgentId: uuid("assigned_agent_id"),
  intent: text("intent").notNull(),
  title: text("title"),
  state: text("state", { enum: TASK_STATES }).notNull().default("REQUESTED"),
  version: integer("version").notNull().default(0),
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  plan: jsonb("plan").$type<unknown>(),
  result: jsonb("result").$type<unknown>(),
  error: jsonb("error").$type<{ message: string; code?: string } | null>(),
  attempts: integer("attempts").notNull().default(0),
  deadline: ts("deadline"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId, t.dependsOnTaskId] })],
);

export const workflowExecutions = pgTable("workflow_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  taskId: uuid("task_id").notNull(),
  step: text("step").notNull(),
  attempt: integer("attempt").notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  output: jsonb("output").$type<unknown>(),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  taskId: uuid("task_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  toolName: text("tool_name").notNull(),
  tier: smallint("tier").notNull(),
  actionDigest: text("action_digest").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  summary: text("summary").notNull(),
  status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  confirmedBy: text("confirmed_by"),
  confirmedAt: ts("confirmed_at"),
  consumedAt: ts("consumed_at"),
});

// ---------- Milestone 3: integrations and inbox ----------

export const INTEGRATION_PROVIDERS = ["google", "hubspot", "stripe"] as const;
export const CONVERSATION_CATEGORIES = ["lead", "client_request", "billing", "scheduling", "vendor", "spam", "other"] as const;
export type ConversationCategory = (typeof CONVERSATION_CATEGORIES)[number];

export const integrationConnections = pgTable("integration_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  provider: text("provider", { enum: INTEGRATION_PROVIDERS }).notNull(),
  accountLabel: text("account_label").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  secretRef: text("secret_ref").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  status: text("status", { enum: ["active", "revoked", "error"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const emailIdentities = pgTable("email_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  integrationConnectionId: uuid("integration_connection_id").notNull(),
  address: text("address").notNull(),
  mode: text("mode", { enum: ["draft_only", "send_with_approval"] }).notNull().default("draft_only"),
  syncCursor: text("sync_cursor"),
  lastSyncedAt: ts("last_synced_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  emailIdentityId: uuid("email_identity_id"),
  channel: text("channel", { enum: ["email"] }).notNull().default("email"),
  subject: text("subject").notNull().default(""),
  externalThreadId: text("external_thread_id").notNull(),
  category: text("category", { enum: CONVERSATION_CATEGORIES }),
  summary: text("summary"),
  draftExternalId: text("draft_external_id"),
  draftMessageId: text("draft_message_id"),
  draftBody: text("draft_body"),
  lastMessageAt: ts("last_message_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  sender: text("sender").notNull(),
  recipients: text("recipients").array().notNull().default([]),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  externalId: text("external_id").notNull(),
  rfc822MessageId: text("rfc822_message_id"),
  sentAt: ts("sent_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Milestone 4: CRM ----------

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull().default(""),
  email: text("email"),
  phone: text("phone"),
  company: text("company"),
  source: text("source", { enum: ["manual", "inbox", "crm_sync", "agent"] }).notNull().default("manual"),
  externalId: text("external_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const crmRecords = pgTable("crm_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  contactId: uuid("contact_id"),
  provider: text("provider", { enum: ["hubspot", "fake"] }).notNull(),
  kind: text("kind", { enum: ["deal"] }).notNull().default("deal"),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  stage: text("stage").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }),
  syncedAt: ts("synced_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Milestone 5: invoices ----------

export const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  contactId: uuid("contact_id"),
  provider: text("provider", { enum: ["stripe", "fake"] }).notNull(),
  externalId: text("external_id").notNull(),
  number: text("number"),
  customerEmail: text("customer_email"),
  customerName: text("customer_name"),
  status: text("status", { enum: INVOICE_STATUSES }).notNull(),
  amountDueCents: bigint("amount_due_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("usd"),
  dueDate: date("due_date", { mode: "string" }),
  hostedUrl: text("hosted_url"),
  lastReminderAt: ts("last_reminder_at"),
  syncedAt: ts("synced_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Milestone 7: memory ----------

export const memoryRecords = pgTable("memory_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  layer: text("layer", { enum: ["working", "org"] }).notNull(),
  scopeRef: text("scope_ref").notNull(),
  content: text("content").notNull(),
  sourceRef: text("source_ref"),
  createdByAgent: uuid("created_by_agent"),
  createdByUser: text("created_by_user"),
  trust: text("trust", { enum: ["user", "verified", "agent"] }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Milestone 8: metering and billing ----------

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  status: text("status").notNull(),
  priceId: text("price_id"),
  currentPeriodEnd: ts("current_period_end"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  lastEventAt: ts("last_event_at"),
});

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  agentId: uuid("agent_id"),
  taskId: uuid("task_id"),
  kind: text("kind", { enum: ["model_tokens", "tool_call"] }).notNull(),
  quantity: bigint("quantity", { mode: "number" }).notNull(),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
  provider: text("provider"),
  model: text("model"),
  purpose: text("purpose"),
  idempotencyKey: text("idempotency_key"),
  at: ts("at").notNull().defaultNow(),
});

export const billingLedger = pgTable("billing_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  entryType: text("entry_type", { enum: ["subscription_payment", "usage", "credit", "refund"] }).notNull(),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
  period: text("period").notNull(),
  stripeRef: text("stripe_ref"),
  at: ts("at").notNull().defaultNow(),
});

export const webhookEvents = pgTable("webhook_events", {
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

// ---------- Milestone 12: lead bot chat ----------

export const chatThreads = pgTable("chat_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  title: text("title").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  threadId: uuid("thread_id").notNull(),
  authorType: text("author_type", { enum: ["user", "lead"] }).notNull(),
  authorUserId: text("author_user_id"),
  content: text("content").notNull(),
  provider: text("provider"),
  model: text("model"),
  mock: boolean("mock").notNull().default(false),
  clientRef: text("client_ref"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const chatDelegations = pgTable("chat_delegations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  threadId: uuid("thread_id").notNull(),
  messageId: uuid("message_id").notNull(),
  taskId: uuid("task_id").notNull(),
  agentKind: text("agent_kind").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Scout OS: entitlements ----------

export const usageCounters = pgTable(
  "usage_counters",
  {
    tenantId: uuid("tenant_id").notNull(),
    metric: text("metric").notNull(),
    period: text("period").notNull(),
    used: bigint("used", { mode: "number" }).notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.metric, t.period] })],
);

// ---------- Scout OS: lead intelligence (migration 0011) ----------

export const OPPORTUNITY_STAGES = ["prospect", "engaged", "qualified", "opportunity", "disqualified"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
export const SIGNAL_KINDS = ["hail", "wind", "tornado"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export const PERMISSION_BASES = ["existing_customer", "inbound_inquiry", "express_written_consent"] as const;
export const SUPPRESSION_REASONS = ["opt_out", "bounce", "complaint", "manual"] as const;

export interface ServiceArea {
  states: string[];
  counties: { state: string; county: string }[];
  center: { lat: number; lon: number } | null;
}
export interface ScoutSettings {
  radiusMiles?: number;
  lookbackDays?: number;
  minScore?: number;
  retentionDays?: number;
  /** Customer-reported: what they pay per month for lists/data. */
  monthlyDataCostCents?: number;
  /** Customer-reported: their typical job value, used only for labelled estimates. */
  averageJobValueCents?: number;
}

export const businessProfiles = pgTable("business_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  vertical: text("vertical", { enum: ["roofing"] }).notNull(),
  website: text("website"),
  services: text("services").array().notNull().default([]),
  idealCustomer: text("ideal_customer").notNull().default(""),
  serviceArea: jsonb("service_area").$type<ServiceArea>().notNull(),
  settings: jsonb("settings").$type<ScoutSettings>().notNull().default({}),
  status: text("status", { enum: ["draft", "reviewed"] }).notNull().default("draft"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const intelligenceSources = pgTable("intelligence_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind", { enum: ["noaa_spc_storm_reports", "crm_contacts", "customer_import"] }).notNull(),
  label: text("label").notNull(),
  usageRights: text("usage_rights").notNull(),
  attestation: text("attestation"),
  attestedBy: text("attested_by"),
  attestedAt: ts("attested_at"),
  rowCount: integer("row_count").notNull().default(0),
  demo: boolean("demo").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const signalObservations = pgTable("signal_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  kind: text("kind", { enum: SIGNAL_KINDS }).notNull(),
  eventAt: ts("event_at").notNull(),
  collectedAt: ts("collected_at").notNull().defaultNow(),
  location: text("location").notNull(),
  county: text("county").notNull(),
  state: text("state").notNull(),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  magnitude: numeric("magnitude", { mode: "number" }),
  magnitudeUnit: text("magnitude_unit", { enum: ["in", "mph"] }),
  comments: text("comments").notNull().default(""),
  confidence: text("confidence").notNull(),
  limitations: text("limitations").notNull(),
  externalRef: text("external_ref").notNull(),
  demo: boolean("demo").notNull().default(false),
});

export const prospects = pgTable("prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  sourceRow: integer("source_row"),
  contactId: uuid("contact_id"),
  kind: text("kind", { enum: ["person", "organization"] }).notNull().default("person"),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  city: text("city"),
  county: text("county"),
  state: text("state"),
  postalCode: text("postal_code"),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  dedupeKey: text("dedupe_key").notNull(),
  retentionUntil: ts("retention_until").notNull(),
  demo: boolean("demo").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const opportunities = pgTable("opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  prospectId: uuid("prospect_id").notNull(),
  vertical: text("vertical", { enum: ["roofing"] }).notNull(),
  stage: text("stage", { enum: OPPORTUNITY_STAGES }).notNull().default("prospect"),
  score: integer("score").notNull(),
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, unknown>>().notNull(),
  explanation: jsonb("explanation").$type<Record<string, unknown>>().notNull(),
  signalIds: uuid("signal_ids").array().notNull(),
  qualification: jsonb("qualification").$type<Record<string, unknown>>(),
  disqualifiedReason: text("disqualified_reason"),
  handoffTaskId: uuid("handoff_task_id"),
  demo: boolean("demo").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const opportunityEvents = pgTable("opportunity_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  opportunityId: uuid("opportunity_id").notNull(),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
  actorId: text("actor_id").notNull(),
  evidence: text("evidence").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const communicationPermissions = pgTable("communication_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  channel: text("channel", { enum: ["email"] }).notNull(),
  value: text("value").notNull(),
  basis: text("basis", { enum: PERMISSION_BASES }).notNull(),
  evidence: text("evidence").notNull(),
  recordedBy: text("recorded_by").notNull(),
  recordedAt: ts("recorded_at").notNull().defaultNow(),
  revokedBy: text("revoked_by"),
  revokedAt: ts("revoked_at"),
});

export const suppressionList = pgTable("suppression_list", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  channel: text("channel", { enum: ["email"] }).notNull(),
  value: text("value").notNull(),
  reason: text("reason", { enum: SUPPRESSION_REASONS }).notNull(),
  addedBy: text("added_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const outreachEvents = pgTable("outreach_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  opportunityId: uuid("opportunity_id"),
  channel: text("channel", { enum: ["email"] }).notNull(),
  recipient: text("recipient").notNull(),
  kind: text("kind", { enum: ["sent", "blocked"] }).notNull(),
  reason: text("reason"),
  actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
  actorId: text("actor_id").notNull(),
  ref: text("ref"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- R1: routines engine ----------

export const ROUTINE_KINDS = ["morning_briefing"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];
export const ROUTINE_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export const ROUTINE_SKIP_REASONS = ["agents_paused", "quota_exceeded", "routine_paused"] as const;

export interface RoutineSourceUse {
  source: string;
  rows: number;
  asOf: string;
}

export const routines = pgTable("routines", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind", { enum: ROUTINE_KINDS }).notNull(),
  name: text("name").notNull(),
  agentKind: text("agent_kind", { enum: ["coordinator"] }).notNull().default("coordinator"),
  hour: smallint("hour").notNull(),
  minute: smallint("minute").notNull(),
  daysOfWeek: smallint("days_of_week").array().notNull(),
  timezone: text("timezone").notNull(),
  maxTier: smallint("max_tier").notNull().default(0),
  status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
  nextRunAt: ts("next_run_at"),
  lastRunAt: ts("last_run_at"),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const routineRuns = pgTable("routine_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  routineId: uuid("routine_id").notNull(),
  trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  scheduledFor: ts("scheduled_for").notNull(),
  status: text("status", { enum: ROUTINE_RUN_STATUSES }).notNull(),
  skipReason: text("skip_reason", { enum: ROUTINE_SKIP_REASONS }),
  sources: jsonb("sources").$type<RoutineSourceUse[]>().notNull().default([]),
  output: jsonb("output").$type<unknown>(),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

// ---------- gaps-1: routine recovery + payment-detail guard ----------

export const ROUTINE_RECOVERY_REASONS = ["missing_job", "expired_job"] as const;
export type RoutineRecoveryReason = (typeof ROUTINE_RECOVERY_REASONS)[number];

export const routineRecoveries = pgTable("routine_recoveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  routineId: uuid("routine_id").notNull(),
  scheduledFor: ts("scheduled_for").notNull(),
  recoveredAt: ts("recovered_at").notNull().defaultNow(),
  reason: text("reason", { enum: ROUTINE_RECOVERY_REASONS }).notNull(),
});

export const PAYMENT_DESTINATION_KINDS = ["customer", "vendor", "payee"] as const;
export type PaymentDestinationKind = (typeof PAYMENT_DESTINATION_KINDS)[number];

export const paymentDestinations = pgTable("payment_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind", { enum: PAYMENT_DESTINATION_KINDS }).notNull(),
  contactId: uuid("contact_id"),
  label: text("label").notNull(),
  accountLast4: text("account_last4").notNull(),
  routingLast4: text("routing_last4"),
  ciphertext: text("ciphertext").notNull(),
  status: text("status", { enum: ["active", "replaced"] }).notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const PAYMENT_CHANGE_STATUSES = ["awaiting_callback", "awaiting_approval", "approved", "rejected", "cancelled"] as const;
export type PaymentChangeStatus = (typeof PAYMENT_CHANGE_STATUSES)[number];
export const PAYMENT_CHANGE_SOURCES = ["agent", "email", "chat", "user"] as const;

export const paymentDetailChanges = pgTable("payment_detail_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind", { enum: PAYMENT_DESTINATION_KINDS }).notNull(),
  contactId: uuid("contact_id"),
  destinationId: uuid("destination_id"),
  label: text("label").notNull(),
  proposedAccountLast4: text("proposed_account_last4").notNull(),
  proposedRoutingLast4: text("proposed_routing_last4"),
  proposedCiphertext: text("proposed_ciphertext").notNull(),
  source: text("source", { enum: PAYMENT_CHANGE_SOURCES }).notNull(),
  approvalRequestId: uuid("approval_request_id"),
  taskId: uuid("task_id"),
  status: text("status", { enum: PAYMENT_CHANGE_STATUSES }).notNull().default("awaiting_callback"),
  callbackPhoneUsed: text("callback_phone_used"),
  callbackVerifiedAt: ts("callback_verified_at"),
  callbackVerifiedBy: text("callback_verified_by"),
  callbackNotes: text("callback_notes"),
  flaggedOnHome: boolean("flagged_on_home").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
});

// ---------- gaps-2: front desk, AI answers, job photos, incoming docs ----------

export const FRONT_DESK_STATUSES = ["active", "paused"] as const;
export const frontDeskChannels = pgTable("front_desk_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  // Only the SHA-256 of the public token is stored; the plaintext is shown once at creation.
  tokenHash: text("token_hash").notNull(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  disclosure: text("disclosure").notNull(),
  status: text("status", { enum: FRONT_DESK_STATUSES }).notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const frontDeskSlots = pgTable("front_desk_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  startsAt: ts("starts_at").notNull(),
  endsAt: ts("ends_at").notNull(),
  capacity: smallint("capacity").notNull().default(1),
  reservedCount: smallint("reserved_count").notNull().default(0),
});

export const FRONT_DESK_REQUESTER_KINDS = ["person", "ai_agent"] as const;
export const FRONT_DESK_BOOKING_STATUSES = ["pending_approval", "confirmed", "rejected", "cancelled", "blocked"] as const;
export const frontDeskBookings = pgTable("front_desk_bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  slotId: uuid("slot_id").notNull(),
  requesterKind: text("requester_kind", { enum: FRONT_DESK_REQUESTER_KINDS }).notNull(),
  agentName: text("agent_name"),
  agentProvider: text("agent_provider"),
  disclosureAck: boolean("disclosure_ack").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  notes: text("notes"),
  clientRef: text("client_ref"),
  sourceIpHash: text("source_ip_hash").notNull(),
  status: text("status", { enum: FRONT_DESK_BOOKING_STATUSES }).notNull().default("pending_approval"),
  approvalRequestId: uuid("approval_request_id"),
  taskId: uuid("task_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
});

export const frontDeskRateBuckets = pgTable("front_desk_rate_buckets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  bucketKey: text("bucket_key").notNull(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

export const aiAnswerChecks = pgTable("ai_answer_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  period: text("period").notNull(),
  trade: text("trade").notNull(),
  zip: text("zip").notNull(),
  recommended: boolean("recommended").notNull(),
  score: smallint("score").notNull(),
  provider: text("provider").notNull(),
  suggestions: jsonb("suggestions").$type<string[]>().notNull().default([]),
  trendDelta: smallint("trend_delta"),
  routineRunId: uuid("routine_run_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const JOB_PHOTO_INTEGRITY = ["ok", "edited", "reuploaded", "broken_chain"] as const;
export const jobPhotos = pgTable("job_photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  jobId: uuid("job_id").notNull(),
  sha256: text("sha256").notNull(),
  prevSha256: text("prev_sha256"),
  chainIndex: integer("chain_index").notNull(),
  captureAt: ts("capture_at").notNull(),
  uploadedAt: ts("uploaded_at").notNull().defaultNow(),
  uploaderUserId: text("uploader_user_id").notNull(),
  gpsLat: doublePrecision("gps_lat"),
  gpsLng: doublePrecision("gps_lng"),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  storageRef: text("storage_ref").notNull(),
  integrityStatus: text("integrity_status", { enum: JOB_PHOTO_INTEGRITY }).notNull().default("ok"),
  integrityNote: text("integrity_note"),
});

export const INCOMING_DOC_KINDS = ["invoice", "estimate"] as const;
export const INCOMING_DOC_STATUSES = ["flagged", "cleared", "rejected", "paid_elsewhere"] as const;
export const incomingDocuments = pgTable("incoming_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind", { enum: INCOMING_DOC_KINDS }).notNull(),
  vendorName: text("vendor_name").notNull(),
  vendorEmail: text("vendor_email"),
  documentNumber: text("document_number"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("usd"),
  senderDomain: text("sender_domain"),
  expectedDomain: text("expected_domain"),
  accountLast4: text("account_last4"),
  destinationId: uuid("destination_id"),
  pdfMetadata: jsonb("pdf_metadata").$type<Record<string, unknown>>().notNull().default({}),
  riskFlags: jsonb("risk_flags").$type<string[]>().notNull().default([]),
  riskScore: smallint("risk_score").notNull().default(0),
  status: text("status", { enum: INCOMING_DOC_STATUSES }).notNull().default("flagged"),
  approvalRequestId: uuid("approval_request_id"),
  taskId: uuid("task_id"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
});
