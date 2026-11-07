import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; password: string };
const shots = evidenceDir("kimi-round1");

async function signIn(page: Page) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 8000 });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
}

test("first run, activity, memory, and opportunities stay spacious and labelled", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto(`/orgs/${seed.orgId}/first-run`);
  await expect(page.getByRole("heading", { name: "Your first 10 minutes" })).toBeVisible();
  await expect(page.getByText("DEMO reply")).toBeVisible();
  await expect(page.getByText("not sent until you approve")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "first-run.png"), fullPage: true });

  await page.goto(`/orgs/${seed.orgId}/approvals`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "approvals.png"), fullPage: true });

  await page.goto(`/orgs/${seed.orgId}/activity`);
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "activity.png"), fullPage: true });

  await page.goto(`/orgs/${seed.orgId}/memory`);
  await expect(page.getByRole("heading", { name: "What Scout knows" })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "memory.png"), fullPage: true });

  await page.goto(`/orgs/${seed.orgId}/opportunities`);
  await expect(page.getByRole("heading", { name: "Opportunities" })).toBeVisible();
  await expect(page.getByText("Nothing is sent")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "opportunities.png"), fullPage: true });
});
