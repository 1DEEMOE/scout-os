import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { password: string };
const shots = evidenceDir("onboarding");

async function signIn(page: Page, email: string) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
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

test("guided setup: create org → DEMO → first Morning Briefing under 15 minutes", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@e2e.test");

  const t0 = Date.now();
  await page.goto("/orgs");
  await page.getByLabel("Organization name").fill(`Plug Play Roof ${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/orgs\/[^/]+\/setup/, { timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "01-industry.png"), fullPage: true });

  await page.getByRole("button", { name: /Roofing/ }).click();
  await expect(page.getByRole("heading", { name: "Business basics" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "02-basics.png"), fullPage: true });

  // Name is prefilled from create-org; timezone auto-detected. ZIP drives Scout.
  await page.getByLabel("Service-area ZIP").fill("75201");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Get to first value" })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(shots, "03-data.png"), fullPage: true });

  await page.getByRole("button", { name: "Load DEMO sample" }).click();
  await expect(page.getByRole("heading", { name: "Connect tools later" })).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: path.join(shots, "04-connect.png"), fullPage: true });

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: /Invite your crew/ })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "05-invite.png"), fullPage: true });

  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: /Generate your first Morning Briefing/ })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "06-finish.png"), fullPage: true });

  await page.getByRole("button", { name: /Finish & open briefing/ }).click();
  await expect(page).toHaveURL(/\/routines\/briefing/, { timeout: 60_000 });
  // Briefing page shows at least one section heading from the coordinator pack.
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, "07-briefing.png"), fullPage: true });

  const elapsedMs = Date.now() - t0;
  writeFileSync(path.join(shots, "wizard-timing.json"), JSON.stringify({ elapsedMs, elapsedSec: Math.round(elapsedMs / 1000), under15Min: elapsedMs < 15 * 60_000 }, null, 2));
  expect(elapsedMs).toBeLessThan(15 * 60_000);
});
