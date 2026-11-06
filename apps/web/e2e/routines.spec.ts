import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; password: string };

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(seed.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
}

test("owner creates a Morning Briefing, runs it now, the worker writes it, and it shows the pending approvals", async ({ page }) => {
  await signIn(page, "owner2@e2e.test");
  await page.goto(`/orgs/${seed.orgId}/routines`);
  await expect(page.getByText("No routines yet.")).toBeVisible();
  await page.getByLabel("Time zone (IANA)").fill("America/New_York");
  await page.getByRole("button", { name: "Create routine" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Queued.")).toBeVisible();
  await expect(async () => {
    await page.goto(`/orgs/${seed.orgId}/routines/briefing`);
    await expect(page.getByText("Waiting for your approval")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  // Earlier specs decide some seeded approvals; at least one is still waiting.
  await expect(page.getByRole("heading", { name: /Waiting for your approval [1-9]/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Overdue invoices/ })).toBeVisible();
  await expect(page.getByText("Scout isn't included in the Starter plan.")).toBeVisible();
});
