import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, InvalidTenantError, withGlobal, withTenant, withUser } from "../src/index";
import { ownerQuery, resetDb, seedUser } from "./helpers";

// Tenant isolation proof for Milestone 1. Tables are discovered from the live
// schema, so any table added later with a tenant_id column is covered
// automatically and fails here until it has forced RLS.

const A = randomUUID();
const B = randomUUID();

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function expectPgError(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e as { message: string; cause?: { message: string } },
  );
  expect(err, "expected the query to fail").toBeDefined();
  expect(err?.cause?.message ?? err?.message).toMatch(pattern);
}

type TableInfo = { table: string; key: string };
let tenantTables: TableInfo[] = [];

// Puts at least one row in every tenant table. A new tenant table without a
// seed row here fails the "zero rows of tenant B" test, which is deliberate.
async function seedTenant(tenantId: string, userId: string) {
  await withTenant(tenantId, async (tx) => {
    const one = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows[0] as Record<string, string>;
    await tx.execute(sql`INSERT INTO organizations (id, name) VALUES (${tenantId}, ${"Org " + userId})`);
    await tx.execute(sql`INSERT INTO organization_members (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, 'owner')`);
    const agent = await one(sql`INSERT INTO agents (tenant_id, kind, display_name) VALUES (${tenantId}, 'inbox', 'Inbox') RETURNING id`);
    await tx.execute(sql`INSERT INTO agent_versions (tenant_id, agent_id, version, instructions, created_by) VALUES (${tenantId}, ${agent.id}, 1, 'x', ${userId})`);
    await tx.execute(sql`INSERT INTO agent_permissions (tenant_id, agent_id, tool_name, max_tier) VALUES (${tenantId}, ${agent.id}, 'noop', 1)`);
    const t1 = await one(sql`INSERT INTO tasks (tenant_id, requested_by, intent) VALUES (${tenantId}, ${userId}, 'first') RETURNING id`);
    const t2 = await one(sql`INSERT INTO tasks (tenant_id, requested_by, intent) VALUES (${tenantId}, ${userId}, 'second') RETURNING id`);
    await tx.execute(sql`INSERT INTO task_dependencies (tenant_id, task_id, depends_on_task_id) VALUES (${tenantId}, ${t2.id}, ${t1.id})`);
    await tx.execute(sql`INSERT INTO workflow_executions (tenant_id, task_id, step, attempt, status, idempotency_key) VALUES (${tenantId}, ${t1.id}, 'noop', 1, 'running', 'k')`);
    await tx.execute(sql`INSERT INTO approval_requests (tenant_id, task_id, agent_id, tool_name, tier, action_digest, payload, summary, expires_at)
      VALUES (${tenantId}, ${t1.id}, ${agent.id}, 'noop', 2, ${"a".repeat(64)}, '{}', 'x', now() + interval '1 day')`);
    const conn = await one(sql`INSERT INTO integration_connections (tenant_id, provider, account_label, secret_ref, secret_ciphertext, created_by)
      VALUES (${tenantId}, 'google', ${userId + "@mail.test"}, 'v1', 'x', ${userId}) RETURNING id`);
    const ident = await one(sql`INSERT INTO email_identities (tenant_id, integration_connection_id, address) VALUES (${tenantId}, ${conn.id}, ${userId + "@mail.test"}) RETURNING id`);
    const conv = await one(sql`INSERT INTO conversations (tenant_id, email_identity_id, subject, external_thread_id) VALUES (${tenantId}, ${ident.id}, 'Hello', 'thr-1') RETURNING id`);
    await tx.execute(sql`INSERT INTO messages (tenant_id, conversation_id, direction, sender, external_id, sent_at) VALUES (${tenantId}, ${conv.id}, 'inbound', 'x@y.test', 'm-1', now())`);
    const contact = await one(sql`INSERT INTO contacts (tenant_id, name, email) VALUES (${tenantId}, 'Lead', ${userId + "@lead.test"}) RETURNING id`);
    await tx.execute(sql`INSERT INTO crm_records (tenant_id, contact_id, provider, external_id, name, stage) VALUES (${tenantId}, ${contact.id}, 'fake', 'd-1', 'Deal', 'new')`);
    await tx.execute(sql`INSERT INTO invoices (tenant_id, contact_id, provider, external_id, status, amount_due_cents) VALUES (${tenantId}, ${contact.id}, 'fake', 'in-1', 'open', 1000)`);
    await tx.execute(sql`INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, status) VALUES (${tenantId}, 'cus', ${"sub_" + userId}, 'active')`);
    await tx.execute(sql`INSERT INTO usage_events (tenant_id, kind, quantity, cost_micros) VALUES (${tenantId}, 'model_tokens', 10, 30)`);
    await tx.execute(sql`INSERT INTO business_profiles (tenant_id, vertical, updated_by) VALUES (${tenantId}, 'roofing', ${userId})`);
    const src = await one(sql`INSERT INTO intelligence_sources (tenant_id, kind, label, usage_rights, created_by) VALUES (${tenantId}, 'noaa_spc_storm_reports', 'SPC', 'public domain', ${userId}) RETURNING id`);
    const sig = await one(sql`INSERT INTO signal_observations (tenant_id, source_id, kind, event_at, location, county, state, confidence, limitations, external_ref)
      VALUES (${tenantId}, ${src.id}, 'hail', now(), 'Town', 'County', 'TX', 'preliminary', 'none', ${"ref-" + userId}) RETURNING id`);
    const pros = await one(sql`INSERT INTO prospects (tenant_id, source_id, name, dedupe_key, retention_until, contact_id) VALUES (${tenantId}, ${src.id}, 'Owner', ${"dk-" + userId}, now() + interval '1 year', ${contact.id}) RETURNING id`);
    const opp = await one(sql`INSERT INTO opportunities (tenant_id, prospect_id, vertical, score, score_breakdown, explanation, signal_ids)
      VALUES (${tenantId}, ${pros.id}, 'roofing', 50, '{}', '{}', ARRAY[${sig.id}]::uuid[]) RETURNING id`);
    await tx.execute(sql`INSERT INTO opportunity_events (tenant_id, opportunity_id, to_stage, actor_type, actor_id, evidence) VALUES (${tenantId}, ${opp.id}, 'prospect', 'system', 'seed', 'seed')`);
    await tx.execute(sql`INSERT INTO communication_permissions (tenant_id, channel, value, basis, evidence, recorded_by) VALUES (${tenantId}, 'email', ${userId + "@lead.test"}, 'inbound_inquiry', 'seed', ${userId})`);
    await tx.execute(sql`INSERT INTO suppression_list (tenant_id, channel, value, reason, added_by) VALUES (${tenantId}, 'email', ${"no-" + userId + "@lead.test"}, 'opt_out', ${userId})`);
    await tx.execute(sql`INSERT INTO outreach_events (tenant_id, opportunity_id, channel, recipient, kind, reason, actor_type, actor_id) VALUES (${tenantId}, ${opp.id}, 'email', 'x@y.test', 'blocked', 'suppressed', 'system', 'seed')`);
    await tx.execute(sql`INSERT INTO usage_counters (tenant_id, metric, period, used) VALUES (${tenantId}, 'tasks', '2026-11', 1)`);
    const routine = await one(sql`INSERT INTO routines (tenant_id, kind, name, hour, minute, days_of_week, timezone, next_run_at, created_by, updated_by)
      VALUES (${tenantId}, 'morning_briefing', 'Briefing', 7, 0, ARRAY[1,2,3,4,5]::smallint[], 'America/New_York', now(), ${userId}, ${userId}) RETURNING id`);
    await tx.execute(sql`INSERT INTO routine_runs (tenant_id, routine_id, trigger, idempotency_key, scheduled_for, status, output, finished_at)
      VALUES (${tenantId}, ${routine.id}, 'schedule', 'schedule:seed', now(), 'succeeded', '{}'::jsonb, now())`);
    await tx.execute(sql`INSERT INTO routine_recoveries (tenant_id, routine_id, scheduled_for, reason)
      VALUES (${tenantId}, ${routine.id}, now() - interval '1 hour', 'missing_job')`);
    const dest = await one(sql`INSERT INTO payment_destinations (tenant_id, kind, contact_id, label, account_last4, ciphertext, created_by)
      VALUES (${tenantId}, 'vendor', ${contact.id}, 'Seed vendor', '1234', 'cipher-seed', ${userId}) RETURNING id`);
    const ap = await one(sql`INSERT INTO approval_requests (tenant_id, task_id, agent_id, tool_name, tier, action_digest, payload, summary, expires_at)
      VALUES (${tenantId}, ${t1.id}, ${agent.id}, 'finance.update_payment_destination', 3, ${"b".repeat(64)}, '{}', 'pay', now() + interval '1 day') RETURNING id`);
    await tx.execute(sql`INSERT INTO payment_detail_changes (tenant_id, kind, contact_id, destination_id, label, proposed_account_last4, proposed_ciphertext, source, approval_request_id, task_id, status, created_by)
      VALUES (${tenantId}, 'vendor', ${contact.id}, ${dest.id}, 'Seed vendor', '5678', 'cipher-change', 'agent', ${ap.id}, ${t1.id}, 'awaiting_callback', ${userId})`);
    // token_hash is globally unique, so the seed hash must differ per tenant.
    const channel = await one(sql`INSERT INTO front_desk_channels (tenant_id, token_hash, display_name, disclosure, created_by)
      VALUES (${tenantId}, ${createHash("sha256").update("fd-" + userId).digest("hex")}, 'Front desk', 'Reviewed by a person.', ${userId}) RETURNING id`);
    await tx.execute(sql`INSERT INTO organization_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${tenantId}, ${"inv-" + userId + "@example.test"}, 'member', ${"c".repeat(64)}, ${userId}, now() + interval '7 days')`);
    const slot = await one(sql`INSERT INTO front_desk_slots (tenant_id, channel_id, starts_at, ends_at)
      VALUES (${tenantId}, ${channel.id}, now() + interval '1 day', now() + interval '1 day' + interval '1 hour') RETURNING id`);
    await tx.execute(sql`INSERT INTO front_desk_bookings (tenant_id, channel_id, slot_id, requester_kind, disclosure_ack, customer_name, customer_email, source_ip_hash, status, created_at)
      VALUES (${tenantId}, ${channel.id}, ${slot.id}, 'person', true, 'Pat', ${userId + "@book.test"}, 'abcd', 'pending_approval', now())`);
    await tx.execute(sql`INSERT INTO front_desk_rate_buckets (tenant_id, channel_id, bucket_key, window_start, count)
      VALUES (${tenantId}, ${channel.id}, 'ip:x', now(), 1)`);
    await tx.execute(sql`INSERT INTO ai_answer_checks (tenant_id, period, trade, zip, recommended, score, provider, suggestions)
      VALUES (${tenantId}, '2026-11', 'roofing', '78701', true, 70, 'mock', '["a","b","c"]'::jsonb)`);
    await tx.execute(sql`INSERT INTO job_photos (tenant_id, job_id, sha256, prev_sha256, chain_index, capture_at, uploader_user_id, filename, content_type, byte_length, storage_ref)
      VALUES (${tenantId}, ${t1.id}, ${"a".repeat(64)}, null, 0, now(), ${userId}, 'a.jpg', 'image/jpeg', 12, ${"ref-" + userId})`);
    await tx.execute(sql`INSERT INTO incoming_documents (tenant_id, kind, vendor_name, amount_cents, risk_flags, risk_score, status, created_by)
      VALUES (${tenantId}, 'invoice', 'Vendor', 5000, '["bank_mismatch"]'::jsonb, 40, 'flagged', ${userId})`);
    await tx.execute(sql`INSERT INTO billing_ledger (tenant_id, entry_type, amount_micros, period) VALUES (${tenantId}, 'usage', 30, '2026-11')`);
    await tx.execute(sql`INSERT INTO memory_records (tenant_id, layer, scope_ref, content, trust, created_by_user) VALUES (${tenantId}, 'org', 'org', 'We bill monthly', 'user', ${userId})`);
    const thread = await one(sql`INSERT INTO chat_threads (tenant_id, title, created_by) VALUES (${tenantId}, 'Plan', ${userId}) RETURNING id`);
    const msg = await one(sql`INSERT INTO chat_messages (tenant_id, thread_id, author_type, content) VALUES (${tenantId}, ${thread.id}, 'lead', 'ok') RETURNING id`);
    await tx.execute(sql`INSERT INTO chat_delegations (tenant_id, thread_id, message_id, task_id, agent_kind) VALUES (${tenantId}, ${thread.id}, ${msg.id}, ${t2.id}, 'inbox')`);
    await tx.execute(
      sql`INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, outcome) VALUES (${tenantId}, 'user', ${userId}, 'seed', 'success')`,
    );
  });
}

beforeAll(async () => {
  await resetDb();
  await seedUser("user-a", "a@example.test");
  await seedUser("user-b", "b@example.test");
  await seedTenant(A, "user-a");
  await seedTenant(B, "user-b");

  const rows = await ownerQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
  );
  tenantTables = [{ table: "organizations", key: "id" }, ...rows.map((r) => ({ table: r.table_name, key: "tenant_id" }))];
});

afterAll(async () => {
  await closePool();
});

describe("database roles", () => {
  it("app_user is not a superuser and cannot bypass RLS", async () => {
    const [r] = await ownerQuery<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'",
    );
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("the app connection runs as app_user, which owns no tables", async () => {
    const who = await withGlobal((tx) => tx.execute(sql`SELECT current_user AS u`));
    expect(who.rows[0]?.u).toBe("app_user");
    const owned = await ownerQuery("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_user'");
    expect(owned).toEqual([]);
  });
});

describe("every tenant table", () => {
  it("is discovered", () => {
    expect(tenantTables.map((t) => t.table)).toEqual(
      expect.arrayContaining(["organizations", "organization_members", "audit_events", "chat_threads", "chat_messages", "chat_delegations"]),
    );
  });

  it("has RLS enabled and forced", async () => {
    for (const { table } of tenantTables) {
      const [r] = await ownerQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace",
        [table],
      );
      expect(r, table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("shows tenant A zero rows of tenant B", async () => {
    const report: string[] = [];
    for (const { table, key } of tenantTables) {
      const counts = await withTenant(A, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS total,
                     count(*) FILTER (WHERE ${sql.identifier(key)} = ${B})::int AS other
              FROM ${sql.identifier(table)}`,
        ),
      );
      const { total, other } = counts.rows[0] as { total: number; other: number };
      report.push(`${table.padEnd(22)} tenant A rows=${total}  tenant B rows visible=${other}`);
      expect(other, table).toBe(0);
      expect(total, table).toBeGreaterThan(0);
    }
    console.log(["", "Tenant isolation report (querying as tenant A, app_user):", ...report].join("\n"));
  });

  it("shows no rows when no tenant is set", async () => {
    for (const { table } of tenantTables) {
      const r = await withGlobal((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`));
      expect((r.rows[0] as { n: number }).n, table).toBe(0);
    }
  });
});

describe("writes across tenants", () => {
  it("rejects inserting a row for tenant B while scoped to A", async () => {
    await expectPgError(
      withTenant(A, (tx) =>
        tx.execute(sql`INSERT INTO organization_members (tenant_id, user_id, role) VALUES (${B}, 'user-a', 'admin')`),
      ),
      /row-level security/,
    );
  });

  it("updates and deletes of tenant B rows affect nothing", async () => {
    const res = await withTenant(A, async (tx) => {
      const u = await tx.execute(sql`UPDATE organizations SET name = 'hijacked' WHERE id = ${B}`);
      const d = await tx.execute(sql`DELETE FROM organization_members WHERE tenant_id = ${B}`);
      return [u.rowCount, d.rowCount];
    });
    expect(res).toEqual([0, 0]);
    const after = await withTenant(B, async (tx) => {
      const org = await tx.execute(sql`SELECT name FROM organizations WHERE id = ${B}`);
      const members = await tx.execute(sql`SELECT count(*)::int AS n FROM organization_members`);
      return { name: (org.rows[0] as { name: string }).name, members: (members.rows[0] as { n: number }).n };
    });
    expect(after).toEqual({ name: "Org user-b", members: 1 });
  });

  it("a row can't reference another tenant's parent, even with the id known", async () => {
    const bTask = await withTenant(B, async (tx) => (await tx.execute(sql`SELECT id FROM tasks LIMIT 1`)).rows[0] as { id: string });
    // Scoped to A, inserting an A row that points at B's task violates the composite foreign key.
    await expectPgError(
      withTenant(A, (tx) =>
        tx.execute(sql`INSERT INTO workflow_executions (tenant_id, task_id, step, attempt, status, idempotency_key)
                       VALUES (${A}, ${bTask.id}, 'x', 1, 'running', 'k2')`),
      ),
      /foreign key/,
    );
  });

  it("org memory can't be written with agent trust, even by the app", async () => {
    await expectPgError(
      withTenant(A, (tx) => tx.execute(sql`INSERT INTO memory_records (tenant_id, layer, scope_ref, content, trust, created_by_user) VALUES (${A}, 'org', 'org', 'x', 'agent', 'u')`)),
      /check constraint/,
    );
  });

  it("agent versions are immutable for the app", async () => {
    await expectPgError(withTenant(A, (tx) => tx.execute(sql`UPDATE agent_versions SET instructions = 'evil'`)), /permission denied/);
  });

  it("audit log is append-only for the app", async () => {
    await expectPgError(withTenant(A, (tx) => tx.execute(sql`UPDATE audit_events SET action = 'x'`)), /permission denied/);
    await expectPgError(withTenant(A, (tx) => tx.execute(sql`DELETE FROM audit_events`)), /permission denied/);
  });
});

describe("context handling", () => {
  it("a user context sees only that user's memberships", async () => {
    const rows = await withUser("user-a", (tx) => tx.execute(sql`SELECT tenant_id, user_id FROM organization_members`));
    expect(rows.rows).toEqual([{ tenant_id: A, user_id: "user-a" }]);
  });

  it("tenant setting does not leak to the next use of a pooled connection", async () => {
    await withTenant(A, async () => undefined);
    for (let i = 0; i < 12; i++) {
      const r = await withGlobal((tx) => tx.execute(sql`SELECT current_setting('app.tenant_id', true) AS t`));
      expect([null, ""]).toContain((r.rows[0] as { t: string | null }).t);
    }
  });

  it("rejects a tenant id that is not a UUID", async () => {
    await expect(withTenant("' OR 1=1 --", async () => 1)).rejects.toBeInstanceOf(InvalidTenantError);
  });
});
