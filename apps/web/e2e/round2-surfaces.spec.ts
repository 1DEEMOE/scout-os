import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; password: string };

const PATHS = ["", "/chat", "/inbox", "/approvals", "/routines", "/settings", "/welcome"];

async function signIn(page: Page) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 5000 });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
}

async function walk(page: Page) {
  const crashes: string[] = [];
  page.on("pageerror", (err) => crashes.push(err.message));
  for (const suffix of PATHS) {
    const res = await page.goto(`/orgs/${seed.orgId}${suffix}`);
    expect(res?.status(), suffix || "/").toBeLessThan(500);
    await expect(page.getByRole("heading").first()).toBeVisible();
  }
  expect(crashes).toEqual([]);
}

test("signed-in pages stay up on a phone and a desktop", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await walk(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/orgs");
  await page.getByLabel("Organization name").fill(`Round2 ${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/orgs\/[^/]+\/setup/, { timeout: 15_000 });
  await page.getByPlaceholder("Plumbing, yoga, cafe…").fill("yoga");
  await expect(page.getByRole("button", { name: /Yoga studio/ })).toBeVisible();
  await page.getByPlaceholder("Plumbing, yoga, cafe…").fill("");
  await page.getByPlaceholder("Mobile dog wash").fill("mobile dog wash");
  await page.getByRole("button", { name: "Use the closest pack" }).click();
  await expect(page.getByRole("heading", { name: "Business basics" })).toBeVisible({ timeout: 15_000 });
});
