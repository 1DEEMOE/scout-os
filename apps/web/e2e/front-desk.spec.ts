import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; password: string };
const shots = evidenceDir("front-desk");

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

test("front desk: owner creates a link and times, a customer requests one, it waits for approval", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "owner@e2e.test");
  await page.goto(`/orgs/${seed.orgId}/settings/front-desk`);
  await expect(page.getByRole("heading", { level: 1, name: "Front desk" })).toBeVisible();

  // Create the link: shown once.
  await page.getByLabel("Name customers see").fill("Rivera Bookkeeping");
  await page.getByRole("button", { name: "Create booking link" }).click();
  const code = page.locator("code").filter({ hasText: "/book/" });
  await expect(code).toBeVisible();
  const link = (await code.textContent())!.trim();
  await expect(page.getByText(/can't be shown again/)).toBeVisible();
  await page.screenshot({ path: path.join(shots, "1-link-created.png"), fullPage: true });
  // The one-time link stays until the owner dismisses it, then the desk settings appear.
  await page.waitForTimeout(1500);
  await expect(code).toBeVisible();
  await page.getByRole("button", { name: "I've saved this link" }).click();
  await expect(code).toHaveCount(0);

  // Add times (tomorrow, repeating 2 weeks).
  const tomorrow = new Date(Date.now() + 86_400_000);
  const ymd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  await page.getByLabel("Date").fill(ymd);
  await page.getByLabel("Repeat weekly").selectOption("2");
  await page.getByRole("button", { name: "Add time slots" }).click();
  await expect(page.getByText("Added 2 slots.")).toBeVisible();
  await expect(page.getByText("0 of 1 requested").first()).toBeVisible();
  await expect(page.getByText(/token|[0-9a-f]{64}/i)).toHaveCount(0); // no hash in the page
  await page.screenshot({ path: path.join(shots, "2-schedule.png"), fullPage: true });

  // A customer with no account opens the link on a phone.
  const customer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const c = await customer.newPage();
  c.on("pageerror", (e) => errors.push(e.message));
  await c.goto(link);
  await expect(c.getByRole("heading", { level: 1, name: "Book a time with Rivera Bookkeeping" })).toBeVisible();
  const overflow = await c.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await c.getByText(/9:00 AM/).first().click();
  await c.getByLabel("Your name").fill("Maya Chen");
  await c.getByLabel("Email").fill("maya@chenbakery.test");
  await c.getByRole("checkbox").check();
  await c.screenshot({ path: path.join(shots, "3-customer-booking-phone.png"), fullPage: true });
  await c.getByRole("button", { name: "Request this time" }).click();
  await expect(c.getByText("Request sent.")).toBeVisible();
  await expect(c.getByText(/isn't a confirmed appointment yet/)).toBeVisible();
  await c.screenshot({ path: path.join(shots, "4-customer-sent-phone.png"), fullPage: true });

  // The owner sees it waiting, and in Needs your OK.
  await page.reload();
  await expect(page.getByText("Maya Chen")).toBeVisible();
  await expect(page.getByText("1 of 1 requested")).toBeVisible();
  await page.goto(`/orgs/${seed.orgId}/approvals`);
  await expect(page.getByText(/Maya Chen/).first()).toBeVisible();
  // Warnings name fields in plain English, never internal argument names.
  await expect(page.getByText(/the customer's email, the customer's name and the notes/i).first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/customerEmail|customerName/);
  await page.goto(`/orgs/${seed.orgId}`);
  await expect(page.locator("main")).not.toContainText(/customerEmail|customerName/);

  // Pausing turns the link off.
  await page.goto(`/orgs/${seed.orgId}/settings/front-desk`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  const res = await c.goto(link);
  expect(res?.status()).toBe(404);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("taking requests")).toBeVisible();

  await customer.close();
  expect(errors).toEqual([]);
});
