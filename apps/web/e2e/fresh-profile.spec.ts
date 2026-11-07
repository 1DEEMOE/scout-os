import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { password: string };

/** A brand-new account, phone-sized, on a slow network. It must render without a client crash. */
test("fresh profile at 390x844 on a slow network does not crash", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const crashes: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => crashes.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: 50 * 1024,
    uploadThroughput: 20 * 1024,
  });

  const email = `fresh-${Date.now()}@e2e.test`;
  await signUp(page, email);
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("not in any organization")).toBeVisible();
  expect(crashes, consoleErrors.join("\n")).toEqual([]);
  const noisy = consoleErrors.filter((line) => !/favicon|Download the React DevTools/i.test(line));
  expect(noisy).toEqual([]);
  await context.close();
});

/** The signed-in demo owner opens a brand-new organization, not the seeded workspace. */
test("signed-in demo user enters a fresh organization at 390x844 on a slow network", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const crashes: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => crashes.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: 50 * 1024,
    uploadThroughput: 20 * 1024,
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 8_000 });
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
  await page.getByLabel("Organization name").fill(`Fresh ${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+\/setup/, { timeout: 20_000 });
  const orgId = page.url().match(/orgs\/([0-9a-f-]+)/)![1];
  await page.goto(`/orgs/${orgId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  expect(crashes, consoleErrors.join("\n")).toEqual([]);
  const noisy = consoleErrors.filter((line) => !/favicon|Download the React DevTools/i.test(line));
  expect(noisy).toEqual([]);
  await context.close();
});

async function signUp(page: Page, email: string) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-up");
    await page.getByLabel("Name").fill("Fresh Profile");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("fresh-password-12345");
    await page.getByRole("button", { name: /Sign up|Create account/ }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 12_000 });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
}
