import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = path.resolve(import.meta.dirname, "../../../docs/plans/evidence/scout");

async function signIn(page: Page, email: string) {
  // Sign-in is rate limited per IP: retry after the window.
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

test("Scout pages: DEMO labels, explanations, no damage claims, labelled analytics", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(shots, { recursive: true });
  await signIn(page, "owner@e2e.test");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `/orgs/${seed.scoutOrgId}`;
  const shot = (name: string) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

  // Feed
  await page.goto(`${base}/scout`);
  await expect(page.getByRole("heading", { level: 1, name: "Scout" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Maria Alvarez" })).toBeVisible();
  await expect(page.locator("table").getByText("DEMO").first()).toBeVisible();
  await expect(page.locator("table").getByText("Prospect · not contacted").first()).toBeVisible();
  await expect(page.getByText("Grace Kim")).toHaveCount(0); // outside the service area
  await expect(page.locator("body")).not.toContainText(/warm lead/i);
  await shot("feed");

  // Detail: the six explanation fields, score as a heuristic, provenance
  await page.getByRole("link", { name: "Maria Alvarez" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Maria Alvarez");
  for (const t of ["Why identified", "Why it may be relevant", "What's missing", "Recommended next step", "How sure"]) await expect(page.getByText(t, { exact: true })).toBeVisible();
  await expect(page.getByText("Heuristic score from fixed rules. It is not a probability.")).toBeVisible();
  await expect(page.getByText(/not evidence of damage to this property/).first()).toBeVisible();
  // Demo storm data never claims a real source.
  await expect(page.getByText(/Source: invented sample storm report \(DEMO\)/).first()).toBeVisible();
  await expect(page.getByText(/Source: NOAA SPC/)).toHaveCount(0);
  await expect(page.getByText("not recorded")).toBeVisible(); // no permission to email
  await expect(page.locator("body")).not.toContainText(/roof (is|was) damaged|damaged roof/i);
  await shot("opportunity");

  // A person rules one out from the page
  await page.getByLabel("Reason").fill("Sold the house last year");
  await page.getByRole("button", { name: "Rule out" }).click();
  await expect(page.getByText("Ruled out").first()).toBeVisible();

  // The engaged demo opportunity offers qualification
  await page.goto(`${base}/scout?stage=engaged`);
  await page.getByRole("link", { name: "James Okafor" }).click();
  await expect(page.getByRole("heading", { name: "Qualify" })).toBeVisible();
  await expect(page.getByText(/yes · existing customer/)).toBeVisible();
  await shot("opportunity-engaged");

  // Storm reports: provenance and no map
  await page.goto(`${base}/scout/signals`);
  await expect(page.getByRole("heading", { level: 1, name: "Storm reports" })).toBeVisible();
  await expect(page.getByText("1.75 in.")).toBeVisible();
  await expect(page.getByText(/No map is shown/)).toBeVisible();
  await shot("signals");

  await page.goto(`${base}/scout/setup`);
  await expect(page.getByRole("heading", { level: 1, name: "Scout setup" })).toBeVisible();
  await expect(page.getByText("reviewed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Sample homeowners \(DEMO\)/)).toBeVisible();
  await shot("setup");

  await page.goto(`${base}/scout/contacts`);
  await expect(page.getByRole("heading", { level: 1, name: "Contact rules" })).toBeVisible();
  await expect(page.getByText("james.okafor@example.test")).toBeVisible();
  await shot("contacts");

  // Analytics: every number carries its basis
  await page.goto(`${base}/analytics`);
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  for (const b of ["Observed", "Customer-reported", "Estimated"]) await expect(page.getByText(b, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Attribution unverified/).first()).toBeVisible();
  await shot("analytics");

  // Billing shows Scout allowances on this plan
  await page.goto(`${base}/billing`);
  await expect(page.getByText("Plan: Scout Pro")).toBeVisible();
  await expect(page.getByText("New Scout opportunities this month")).toBeVisible();

  // The other org (Starter) gets an upgrade notice, not data
  await page.goto(`/orgs/${seed.orgId}/scout`);
  await expect(page.getByText(/isn't included in the Starter plan/)).toBeVisible();
  await shot("upgrade");

  expect(errors).toEqual([]);
});

test("a phone-width feed has no horizontal page scroll", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "sam@e2e.test");
  await page.goto(`/orgs/${seed.scoutOrgId}/scout`);
  await expect(page.getByRole("heading", { level: 1, name: "Scout" })).toBeVisible();
  await expect(page.getByRole("list").getByText("DEMO").first()).toBeVisible(); // phone layout shows cards, not the table
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join(shots, "feed-phone.png"), fullPage: true });
});
