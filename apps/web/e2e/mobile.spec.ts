import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const seed = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8"),
) as { orgId: string; scoutOrgId: string; password: string };

const KEY_FLOWS = [
  { suffix: "", name: "Today" },
  { suffix: "/approvals", name: "Approvals" },
  { suffix: "/scout", name: "Leads", scout: true },
  { suffix: "/tasks", name: "Jobs" },
  { suffix: "/routines/briefing", name: "Briefing" },
];

test("key flows are roomy and usable at 390px with bottom nav", async ({ page }) => {
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

  // Bottom nav lives inside the org layout — open Today first.
  await page.goto(`/orgs/${seed.orgId}`);
  await expect(page).toHaveURL(new RegExp(`/orgs/${seed.orgId}`));

  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(primary).toBeVisible();
  for (const label of ["Today", "Approvals", "Work", "Customers", "Leads"]) {
    await expect(primary.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
  }

  for (const flow of KEY_FLOWS) {
    const orgId = flow.scout ? seed.scoutOrgId : seed.orgId;
    const res = await page.goto(`/orgs/${orgId}${flow.suffix}`);
    expect(res?.status(), flow.name).toBe(200);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    expect(overflow, `overflow on ${flow.name}`).toBe(false);

    const cramped = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return "no-main";
      const style = getComputedStyle(main);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      if (padX < 24) return `padX=${padX}`;
      return null;
    });
    expect(cramped, `${flow.name} cramped`).toBeNull();

    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  }
});
