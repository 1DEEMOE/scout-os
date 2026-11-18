import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; password: string };
const shots = evidenceDir("sales-crm");

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

/**
 * Guarantees a front-desk channel exists and returns a fresh public token:
 * creates the desk if the org has none, otherwise rotates the link (the old
 * token is unknown to this spec — only its hash is stored).
 */
async function freshPublicToken(page: Page): Promise<string> {
  await page.goto(`/orgs/${seed.orgId}/settings/front-desk`);
  await expect(page.getByRole("heading", { level: 1, name: "Front desk" })).toBeVisible();
  const createButton = page.getByRole("button", { name: "Create booking link" });
  if (await createButton.count()) {
    await page.getByLabel("Name customers see").fill("Lead Co");
    await createButton.click();
  } else {
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Get a new link" }).click();
  }
  const code = page.locator("code").filter({ hasText: "/book/" });
  await expect(code).toBeVisible();
  const url = (await code.textContent())!.trim();
  const token = /\/book\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  expect(token, "public token in the one-time link").toBeTruthy();
  await page.getByRole("button", { name: "I've saved this link" }).click();
  return token!;
}

test("sales: create a deal, move it through the board, mark it won", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "owner@e2e.test");
  await page.goto(`/orgs/${seed.orgId}/sales`);
  await expect(page.getByRole("heading", { level: 1, name: "Sales" })).toBeVisible();

  await page.getByRole("link", { name: "+ New deal" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New deal" })).toBeVisible();
  await page.getByLabel("Deal name").fill("E2E Pipeline Deal");
  await page.getByLabel("Amount ($)").fill("5000");
  await page.getByRole("button", { name: "Create deal" }).click();

  await expect(page).toHaveURL(/\/sales\/deals\//);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Pipeline Deal" })).toBeVisible();
  await expect(page.getByText("$5,000.00").first()).toBeVisible();

  // Lead → Qualified, then close it won (with the confirm dialog).
  await page.getByRole("button", { name: /Qualified/ }).click();
  await expect(page.getByText("Qualified").first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Mark won" }).click();
  await expect(page.getByText("This deal is won.")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "1-deal-won.png"), fullPage: true });

  // …and it shows under Recently decided on the board.
  await page.goto(`/orgs/${seed.orgId}/sales`);
  await expect(page.getByText("Recently decided")).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Pipeline Deal" })).toBeVisible();
  await expect(page.getByText("Won this month")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "2-board-after-win.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("lead form: enable it, submit as a visitor, see the lead on the board, pause closes it", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "owner@e2e.test");
  const token = await freshPublicToken(page);

  // Turn the lead form on.
  await page.goto(`/orgs/${seed.orgId}/settings/front-desk`);
  await expect(page.getByText("Lead form for your website")).toBeVisible();
  await page.getByLabel("Lead form is on").check();
  await page.getByRole("button", { name: "Save lead form" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // A visitor with no account opens /f/<token> on a phone and sends a message.
  const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const v = await visitor.newPage();
  v.on("pageerror", (e) => errors.push(e.message));
  await v.goto(`/f/${token}`);
  await expect(v.getByRole("heading", { level: 1, name: /Contact Lead Co|Contact/ })).toBeVisible();
  const overflow = await v.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await v.getByLabel("Your name").fill("Maya Lead");
  await v.getByLabel("Email").fill("maya@leadco.test");
  await v.getByLabel(/Company/).fill("Lead Co");
  await v.getByLabel(/Message/).fill("Need a quote this week");
  await v.screenshot({ path: path.join(shots, "3-public-form-phone.png"), fullPage: true });
  await v.getByRole("button", { name: "Send message" }).click();
  await expect(v.getByText("Message sent.")).toBeVisible();
  await v.screenshot({ path: path.join(shots, "4-public-form-sent.png"), fullPage: true });

  // The owner sees the web-form deal on the board…
  await page.goto(`/orgs/${seed.orgId}/sales`);
  const card = page.getByRole("link", { name: /Lead Co — web form/ });
  await expect(card).toBeVisible();
  await page.screenshot({ path: path.join(shots, "5-board-with-lead.png"), fullPage: true });

  // …and the whole story on the contact page (deal → contact → timeline).
  await card.click();
  await expect(page).toHaveURL(/\/sales\/deals\//);
  await page.getByRole("link", { name: "Maya Lead", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/contacts\//);
  await expect(page.getByRole("heading", { level: 1, name: "Maya Lead" })).toBeVisible();
  await expect(page.getByText("Web form").first()).toBeVisible();
  await expect(page.getByText("Need a quote this week", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "6-contact-360.png"), fullPage: true });

  // Pausing the desk closes the public form too.
  await page.goto(`/orgs/${seed.orgId}/settings/front-desk`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  const res = await v.goto(`/f/${token}`);
  expect(res?.status()).toBe(404);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  expect(errors).toEqual([]);
});
