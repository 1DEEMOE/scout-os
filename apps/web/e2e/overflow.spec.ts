import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };

const PAGES = ["", "/approvals", "/inbox", "/sales", "/finance", "/routines", "/settings", "/scout", "/tasks"];

test("main pages have no horizontal overflow at 390px", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 5000 });
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
  for (const suffix of PAGES) {
    const orgId = suffix.startsWith("/scout") ? seed.scoutOrgId : seed.orgId;
    const res = await page.goto(`/orgs/${orgId}${suffix}`);
    expect(res?.status(), suffix).toBe(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    expect(overflow, `overflow on ${suffix}`).toBe(false);
  }
});
