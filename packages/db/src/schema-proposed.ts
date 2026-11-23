import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle mirrors of tables defined in packages/db/proposed/0022_events_and_dead_letters.sql.
 * That SQL is PENDING OWNER REVIEW and is not applied by the migrator, so these
 * tables do not exist in a database until the owner adopts 0022. Code that reads
 * or writes them must stay behind the WOS_DURABLE_EVENTS=1 opt-in. On adoption,
 * move these definitions into schema.ts and delete this file.
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const integrationEvents = pgTable("integration_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  status: text("status", { enum: ["done", "skipped", "dead"] }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const deadLetters = pgTable("dead_letters", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  eventKey: text("event_key").notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  integration: text("integration").notNull().default(""),
  error: text("error").notNull(),
  attempts: integer("attempts").notNull(),
  replayedAt: ts("replayed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const integrationBreakers = pgTable("integration_breakers", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  state: text("state", { enum: ["closed", "open", "half_open"] }).notNull(),
  failures: integer("failures").notNull().default(0),
  openUntil: ts("open_until"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Plain object (not a module namespace) so schema-walking helpers such as
 * drizzle's `is()` and the privacy drift guard ignore it. These are not live
 * tables until 0022 is adopted.
 */
export const proposedSchema = { integrationEvents, deadLetters, integrationBreakers };
