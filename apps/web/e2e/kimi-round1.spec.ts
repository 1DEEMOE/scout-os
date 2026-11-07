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

test("chat remember, a scheduled sentence, takeover, and the new screens do real work", async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  await page.goto(`/orgs/${seed.orgId}/chat`);
  await page.getByLabel("Ask Scout to do something").fill("remember the side gate code is 2468");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Remembered: the side gate code is 2468")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await page.goto(`/orgs/${seed.orgId}/tasks`);
  await page.getByPlaceholder("e.g. Draft replies to this week's billing questions").fill("Note the delivery window for the practice job");
  await page.getByRole("button", { name: "Send to agents" }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/, { timeout: 20_000 });
  await page.getByLabel("Your draft").fill("I'll take this one. This draft is not sent.");
  await page.getByRole("button", { name: "Take over this draft" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "I'll take this one. This draft is not sent." })).toBeVisible();
  await page.getByRole("button", { name: "Hand back" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  await page.goto(`/orgs/${seed.orgId}/goals`);
  await page.getByLabel("What should be true by Friday?").fill("Fill Thursday afternoon");
  await page.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByText("Fill Thursday afternoon")).toBeVisible();

  await page.goto(`/orgs/${seed.orgId}/library`);
  await page.getByLabel("Name").fill("Weekly note");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Weekly note")).toBeVisible();

  await page.goto(`/orgs/${seed.orgId}/settings/notifications`);
  await page.getByRole("button", { name: "Save notification settings" }).click();
  await expect(page.getByText("Done.")).toBeVisible();

  await page.goto(`/orgs/${seed.orgId}/settings/money`);
  await expect(page.getByText("Auto-pay is off.")).toBeVisible();
  await page.getByLabel("Cap in dollars. This does not pay anything.").fill("50000");
  await page.getByRole("button", { name: "Save cap" }).click();
  await expect(page.getByText("$500.00")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "money.png"), fullPage: true });
});

test("a chat sentence schedules a real read-only routine on a new organization", async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await browser.newPage();
  const email = `routine-${Date.now()}@e2e.test`;
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-up");
    await page.getByLabel("Name").fill("Routine Owner");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("routine-password-12345");
    await page.getByRole("button", { name: "Create account" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 12_000 });
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
  await page.getByLabel("Organization name").fill("Routine Shop");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+\/setup/, { timeout: 20_000 });
  const orgId = page.url().match(/orgs\/([0-9a-f-]+)/)![1];
  await page.goto(`/orgs/${orgId}/chat`);
  await page.getByLabel("Ask Scout to do something").fill("every Friday, list next week's customers");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("This is on the schedule. It does not send.")).toBeVisible({ timeout: 20_000 });
  await page.goto(`/orgs/${orgId}/routines`);
  await expect(page.locator("#main").getByRole("link", { name: /Every friday/i })).toBeVisible();
  await expect(page.getByText("active").first()).toBeVisible();
  await page.close();
});
