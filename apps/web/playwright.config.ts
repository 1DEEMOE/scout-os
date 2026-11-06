import { execSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Browser tests against a production build plus a real worker process.
// Uses an installed Chrome (CHROME_PATH) because browser downloads may be blocked.
const db = process.env.E2E_DATABASE_URL ?? "postgres://app_user:app_dev_pw@localhost:5432/wos_e2e";
const port = process.env.E2E_PORT ?? "3100";
const env = {
  DATABASE_URL: db,
  BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-000",
  BETTER_AUTH_URL: `http://localhost:${port}`,
  WOS_MOCK_MODE: "1",
  WOS_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  ANTHROPIC_API_KEY: "",
  LOG_LEVEL: "warn",
  // The operator account that may create client workspaces (seeded with a verified email).
  // MOCK operator only. owner@e2e.test is a normal demo user and is not listed here.
  WOS_PLATFORM_ADMIN_EMAILS: "mock-admin@e2e.test",
};
Object.assign(process.env, env);

// Migrate before the web servers start (they need the job queue schema).
if (!process.env.E2E_SKIP_MIGRATE) {
  execSync("pnpm --filter @wos/db migrate", {
    cwd: path.resolve(import.meta.dirname, "../.."),
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL_OWNER: process.env.E2E_OWNER_DATABASE_URL ?? "postgres://wos_owner:owner_dev_pw@localhost:5432/wos_e2e" },
  });
  process.env.E2E_SKIP_MIGRATE = "1"; // the config is loaded again in worker processes
}

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] },
    trace: "retain-on-failure",
  },
  webServer: [
    { command: `npx next start -p ${port}`, url: `http://localhost:${port}/sign-in`, env, reuseExistingServer: false, timeout: 60_000 },
    { command: "npx tsx worker.ts", env: { ...env, LOG_LEVEL: "info" }, wait: { stdout: /task worker started/ }, reuseExistingServer: false, timeout: 60_000 },
  ],
});
