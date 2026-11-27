#!/usr/bin/env node
/**
 * Live-integration verification — the executable half of
 * docs/plans/live-integration-runbook.md. Run this ON THE STAGING DEPLOYMENT
 * (or against staging's env) after real credentials are set.
 *
 *   node scripts/verify-live-integrations.mjs
 *
 * Exit 0 = everything configured passed. Checks are SKIP (not fail) when a
 * credential is absent, so partial rollouts still produce honest output.
 * Every external call is read-only.
 *
 * Requires the same env the app uses: DATABASE_URL, BETTER_AUTH_SECRET,
 * WOS_SECRETS_KEY, ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID/SECRET,
 * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BETTER_AUTH_URL.
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg");

const results = [];
const report = (name, status, evidence) => {
  results.push({ name, status, evidence });
  console.log(`${status.padEnd(4)}  ${name.padEnd(34)} ${evidence}`);
};

const env = (k) => process.env[k] ?? "";

// 1. Environment completeness -------------------------------------------------
const required = ["DATABASE_URL", "BETTER_AUTH_SECRET", "WOS_SECRETS_KEY", "BETTER_AUTH_URL"];
for (const k of required) {
  const v = env(k);
  const ok = k === "BETTER_AUTH_SECRET" ? v.length >= 32 : v.length > 0;
  report(`env ${k}`, ok ? "PASS" : "FAIL", ok ? "set" : "missing or too short");
}
report("env WOS_MOCK_MODE", env("WOS_MOCK_MODE") === "1" ? "FAIL" : "PASS",
  env("WOS_MOCK_MODE") === "1" ? "MOCK MODE IS ON — this is not a live verification" : "off");

// 2. Database + migrations -----------------------------------------------------
let db;
try {
  db = new pg.Client({ connectionString: env("DATABASE_URL") });
  await db.connect();
  const { rows } = await db.query("SELECT count(*)::int AS n FROM schema_migrations");
  const { rows: rls } = await db.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity",
  );
  report("database", "PASS", `reachable; ${rows[0].n} migrations applied; ${rls[0].n} forced-RLS tables`);
} catch (err) {
  report("database", "FAIL", err.message);
}

// 3. Anthropic — one minimal paid call ----------------------------------------
if (!env("ANTHROPIC_API_KEY")) {
  report("anthropic", "SKIP", "ANTHROPIC_API_KEY not set");
} else {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env("ANTHROPIC_MODEL") ?? "claude-haiku-4-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the word: ok" }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    report("anthropic", "PASS", `model replied; usage=${JSON.stringify(body.usage)}`);
  } catch (err) {
    report("anthropic", "FAIL", err.message);
  }
}

// 4. Stripe — read-only account call + webhook endpoint shape -----------------
if (!env("STRIPE_SECRET_KEY")) {
  report("stripe", "SKIP", "STRIPE_SECRET_KEY not set");
} else {
  try {
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { authorization: `Bearer ${env("STRIPE_SECRET_KEY")}` },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    const mode = env("STRIPE_SECRET_KEY").startsWith("sk_live") ? "LIVE KEY — are you sure this is staging?" : "test-mode key";
    report("stripe api", "PASS", `balance readable (${mode})`);
  } catch (err) {
    report("stripe api", "FAIL", err.message);
  }
}
if (!env("BETTER_AUTH_URL")) {
  report("stripe webhook", "SKIP", "BETTER_AUTH_URL not set");
} else {
  try {
    // Unsigned POST must be rejected with 400 — proves the endpoint verifies signatures.
    const res = await fetch(`${env("BETTER_AUTH_URL")}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_fake", type: "ping" }),
    });
    report("stripe webhook", res.status === 400 ? "PASS" : "FAIL", `unsigned POST -> HTTP ${res.status} (want 400)`);
  } catch (err) {
    report("stripe webhook", "FAIL", err.message);
  }
}

// 5. Health endpoint -----------------------------------------------------------
if (env("BETTER_AUTH_URL")) {
  try {
    const res = await fetch(`${env("BETTER_AUTH_URL")}/api/healthz`);
    const body = await res.json();
    report("healthz", res.ok && body.ok ? "PASS" : "FAIL", JSON.stringify(body));
  } catch (err) {
    report("healthz", "FAIL", err.message);
  }
}

// 6. Connected integrations in the DB (Gmail, HubSpot tokens exist) ------------
if (db) {
  try {
    const { rows } = await db.query(
      "SELECT provider, count(*)::int AS n FROM integration_connections GROUP BY provider ORDER BY provider",
    );
    report("db connections", rows.length ? "PASS" : "SKIP",
      rows.length ? rows.map((r) => `${r.provider}×${r.n}`).join(", ") : "no integration_connections rows — connect Gmail/HubSpot in Settings, then re-run");
  } catch (err) {
    report("db connections", "FAIL", err.message);
  }
  await db.end();
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP").length;
console.log(`\n${results.length - failed.length - skipped} PASS, ${skipped} SKIP, ${failed.length} FAIL`);
console.log(failed.length === 0 ? "Live verification complete for everything configured." : "Fix the FAIL lines before touching real customers.");
process.exit(failed.length === 0 ? 0 : 1);
