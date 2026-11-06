import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Platform admin and approve-all setup run on throwaway workspaces.
 * The seeded E2E Roofing / bookkeeping orgs are never sent through welcome again.
 * The operator is the MOCK platform admin, not owner@e2e.test.
 */
const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };

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

test("mock platform admin can open client invites; the demo owner cannot", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@e2e.test");
  const denied = await owner.goto("/admin/clients");
  expect(denied?.status()).toBe(404);

  const ops = await (await browser.newContext()).newPage();
  await signIn(ops, "mock-admin@e2e.test");
  const ok = await ops.goto("/admin/clients");
  expect(ok?.status()).toBe(200);
  await expect(ops.getByRole("heading", { level: 1, name: "New client workspace" })).toBeVisible();
  await expect(ops.getByText("MOCK Platform Admin")).toBeVisible();
  const trade = ops.getByLabel("Trade");
  await expect(trade.locator("option[value='nail_salon']")).toHaveCount(1);
  await expect(trade.locator("option[value='hvac']")).toHaveCount(1);
  await trade.selectOption("hvac");
  await expect(trade).toHaveValue("hvac");
});

test("approve-all finish runs on a throwaway org and leaves the seeded demo alone", async ({ browser }) => {
  test.setTimeout(180_000);
  const clientEmail = `throwaway+${Date.now()}@example.test`;
  const ops = await (await browser.newContext()).newPage();
  await signIn(ops, "mock-admin@e2e.test");
  await ops.goto("/admin/clients");
  await ops.getByLabel("Business name").fill("Throwaway Nails");
  await ops.getByLabel("Trade").selectOption("nail_salon");
  await ops.getByLabel("Client's email").fill(clientEmail);
  await ops.getByLabel("Type it again to confirm").fill(clientEmail);
  await ops.getByRole("button", { name: "Create workspace and link" }).click();
  const invite = await ops.getByLabel("Invite link").inputValue();

  const client = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await client.goto(invite);
  await expect(client.getByRole("heading", { level: 1, name: "Throwaway Nails" })).toBeVisible();
  await client.getByLabel("Your name").fill("Nia Throwaway");
  await client.getByLabel("Create a password").fill("throwaway-nails-2026");
  await client.getByRole("button", { name: "Open my workspace" }).click();
  await expect(client).toHaveURL(/\/welcome/);
  await expect(client.getByRole("radio", { name: /Nail salon/ })).toBeChecked();
  await client.getByRole("button", { name: "Continue" }).click();
  await client.getByRole("button", { name: "Skip for now" }).click();
  await expect(client.getByRole("checkbox", { name: /Approve the ready-to-send replies/ })).toBeChecked();
  await client.getByRole("button", { name: "Finish and see my briefing" }).click();
  await expect(client).toHaveURL(/\/orgs\/[^/]+\?welcome=1/, { timeout: 60_000 });
  const orgId = new URL(client.url()).pathname.split("/")[2]!;
  expect(orgId).not.toBe(seed.orgId);
  expect(orgId).not.toBe(seed.scoutOrgId);
  await expect(client.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(client.getByText("Respond in 60 seconds")).toBeVisible();

  await client.goto(`/orgs/${orgId}/audit?action=speed.templates.approve_all`);
  await expect(client.getByText("speed.templates.approve_all")).toBeVisible();

  // The shared seeded workspace is not sent through welcome again.
  const demo = await (await browser.newContext()).newPage();
  await signIn(demo, "owner@e2e.test");
  await demo.goto(`/orgs/${seed.scoutOrgId}`);
  await expect(demo).toHaveURL(new RegExp(`/orgs/${seed.scoutOrgId}$`));
  await expect(demo.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(demo.getByRole("heading", { name: "Your business" })).toHaveCount(0);
});
