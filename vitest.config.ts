import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
    // Tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_user:app_dev_pw@localhost:5432/scout_gaps_test",
      DATABASE_URL_OWNER: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://wos_owner:owner_dev_pw@localhost:5432/scout_gaps_test",
      DATABASE_URL_ADMIN: process.env.TEST_DATABASE_URL_ADMIN ?? "postgres://postgres@127.0.0.1:5432/scout_gaps_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
      BETTER_AUTH_URL: "http://localhost:3000",
      LOG_LEVEL: "silent",
      WOS_MOCK_MODE: "1",
      // Test-only key (32 zero bytes). Real deployments set their own.
      WOS_SECRETS_KEY: Buffer.alloc(32).toString("base64"),
      ANTHROPIC_API_KEY: "",
    },
  },
});
