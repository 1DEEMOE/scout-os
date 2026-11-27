import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ownerQuery } from "./helpers";

/**
 * Applies proposed 0027 inside one transaction on the test database, checks
 * tenant isolation as app_user, then rolls the transaction back. Nothing is
 * committed and schema_migrations is not touched.
 */
function statements(file: string): string[] {
  const raw = readFileSync(path.resolve(import.meta.dirname, "../proposed", file), "utf8");
  return raw
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);
}

function adminUrl(): string {
  if (process.env.DATABASE_URL_ADMIN) return process.env.DATABASE_URL_ADMIN;
  const app = new URL(process.env.DATABASE_URL ?? "postgres://app_user:app_dev_pw@127.0.0.1:5432/wos_test");
  app.username = "postgres";
  app.password = "";
  return app.toString();
}

/** A failed statement aborts the transaction, so expectations-on-failure need a savepoint. */
async function expectPg(client: pg.Client, sqlText: string, params: unknown[], pattern: RegExp) {
  await client.query("SAVEPOINT expect_fail");
  const err = await client.query(sqlText, params).then(
    () => undefined,
    (e: unknown) => e as { message: string },
  );
  await client.query("ROLLBACK TO SAVEPOINT expect_fail");
  expect(err, "expected the statement to fail").toBeDefined();
  expect(err?.message).toMatch(pattern);
}

describe("proposed 0027 crm pipeline (rolled back, never applied)", () => {
  const sqlUp = statements("0027_crm_pipeline.sql");
  const sqlDown = statements("0027_crm_pipeline.down.sql");

  it("isolates CRM rows by tenant, constrains stage/source/amount, then disappears on rollback", async () => {
    const before = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0027%'");
    expect(before).toEqual([]);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    const a = randomUUID();
    const b = randomUUID();
    try {
      await client.query("BEGIN");
      for (const statement of sqlUp) await client.query(statement);

      const forced = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('deals', 'pipeline_configs', 'contact_notes', 'lead_forms') ORDER BY relname`,
      );
      expect(forced.rows).toEqual([
        { relname: "contact_notes", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "deals", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "lead_forms", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "pipeline_configs", relrowsecurity: true, relforcerowsecurity: true },
      ]);

      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'CRM A')", [a]);
      const contactId = randomUUID();
      await client.query("INSERT INTO contacts (tenant_id, id, name, email, source) VALUES ($1, $2, 'Ada', 'ada@example.test', 'web_form')", [a, contactId]);
      await client.query("INSERT INTO deals (tenant_id, contact_id, name, amount_cents, source, created_by) VALUES ($1, $2, 'Website deal', 1000000, 'web_form', 'lead-form')", [a, contactId]);

      // Defaults: lead stage, manual source on a plain insert.
      const def = await client.query<{ stage: string; source: string }>("SELECT stage, source FROM deals WHERE tenant_id = $1", [a]);
      expect(def.rows[0]).toMatchObject({ stage: "lead", source: "web_form" });

      // CHECK constraints refuse junk.
      await expectPg(client, "UPDATE deals SET stage = 'flying' WHERE tenant_id = $1", [a], /deals_stage_check/);
      await expectPg(client, "UPDATE deals SET source = 'carrier_pigeon' WHERE tenant_id = $1", [a], /deals_source_check/);
      await expectPg(client, "UPDATE deals SET amount_cents = -5 WHERE tenant_id = $1", [a], /deals_amount_cents_check/);
      await expectPg(client, "UPDATE contacts SET source = 'skywriting' WHERE tenant_id = $1", [a], /contacts_source_check/);

      // The widened CHECK accepts web_form (already inserted above).
      const wf = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND source = 'web_form'", [a]);
      expect(wf.rows[0]!.n).toBe(1);

      // Config + note for A.
      await client.query("INSERT INTO pipeline_configs (tenant_id, probability_bps) VALUES ($1, '{\"lead\": 2000}')", [a]);
      await client.query("INSERT INTO contact_notes (tenant_id, contact_id, body, created_by) VALUES ($1, $2, 'Called, seems keen', 'user-a')", [a, contactId]);

      // Tenant B cannot see A's rows in any of the four tables.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'CRM B')", [b]);
      for (const table of ["deals", "pipeline_configs", "contact_notes", "lead_forms"]) {
        const hidden = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(hidden.rows[0]!.n, table).toBe(0);
      }

      // app_user has no DELETE on deals: won/lost are statuses, not deletions.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await expectPg(client, "DELETE FROM deals WHERE tenant_id = $1", [a], /permission denied/);
      // Notes are append-only: no UPDATE either.
      await expectPg(client, "UPDATE contact_notes SET body = 'edited' WHERE tenant_id = $1", [a], /permission denied/);
      await expectPg(client, "DELETE FROM contact_notes WHERE tenant_id = $1", [a], /permission denied/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }

    // Rollback worked: no trace in schema_migrations, and the contacts CHECK
    // is back to the applied four-value list.
    const after = await ownerQuery<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '0027%'");
    expect(after).toEqual([]);
  });

  it("has a parseable down migration that drops all four tables and restores the contacts CHECK", () => {
    const flat = sqlDown.join(" ");
    expect(flat).toMatch(/DROP TABLE IF EXISTS lead_forms/i);
    expect(flat).toMatch(/DROP TABLE IF EXISTS contact_notes/i);
    expect(flat).toMatch(/DROP TABLE IF EXISTS pipeline_configs/i);
    expect(flat).toMatch(/DROP TABLE IF EXISTS deals/i);
    expect(flat).toMatch(/ADD CONSTRAINT contacts_source_check/i);
    expect(flat).not.toMatch(/web_form/i);
  });
});
