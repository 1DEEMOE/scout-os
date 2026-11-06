import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; emailTaskId: string; deleteTaskId: string; password: string };

// Sign-in is rate limited (a few per 10 s per IP), so each user signs in once
// and later tests reuse the session cookie.
const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>>();

async function signIn(page: Page, email: string) {
  const saved = sessions.get(email);
  if (saved) {
    await page.context().addCookies(saved);
    return;
  }
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(seed.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  sessions.set(email, await page.context().cookies());
}

test.describe.serial("approval center", () => {
  test("a viewer sees what's waiting but can't approve", async ({ page }) => {
    await signIn(page, "viewer@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/approvals`);
    await expect(page.getByText("Email client@customer.test: Your invoice")).toBeVisible();
    await expect(page.getByRole("button", { name: /^OK/ })).toHaveCount(0);
    await expect(page.getByText("Only owners and admins can approve.").first()).toBeVisible();
    // The audit log isn't in a viewer's navigation and is a 404 if typed.
    await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
    const res = await page.goto(`/orgs/${seed.orgId}/audit`);
    expect(res?.status()).toBe(404);
  });

  test("the owner can't approve their own request; the card says why", async ({ page }) => {
    await signIn(page, "owner@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/approvals`);
    const card = page.locator("section", { hasText: "Email bank@example.test: New account" });
    await expect(card.getByText("You asked for this work, so another owner or admin has to approve it.")).toBeVisible();
    await expect(card.getByRole("button", { name: /^OK/ })).toHaveCount(0);
  });

  test("the owner sees who asked and the exact action, approves it, and the worker runs it", async ({ page }) => {
    await signIn(page, "owner@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/approvals`);
    const card = page.locator("section", { hasText: "Email client@customer.test: Your invoice" });
    await expect(card.getByText("Needs your OK").first()).toBeVisible();
    await expect(card.getByText("MOCK", { exact: true })).toBeVisible();
    await expect(card.getByText("Sam Lee")).toBeVisible();
    await card.getByText("Technical details").click();
    await expect(card.getByText("Risk level 2 · external")).toBeVisible();
    await expect(card.locator("pre")).toContainText('"to": "client@customer.test"');
    await card.getByRole("button", { name: "OK", exact: true }).click();
    await expect(page.locator("section", { hasText: "Recently decided" })).toContainText("Email client@customer.test: Your invoice");
    await page.goto(`/orgs/${seed.orgId}/tasks/${seed.emailTaskId}`);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("done", { exact: true }).first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
  });

  test("tier 4: one owner approves, a different owner confirms", async ({ page }) => {
    await signIn(page, "owner@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/approvals`);
    const card = page.locator("section", { hasText: "Permanently delete contact c_duplicate" });
    await expect(card.getByText("Needs two people to OK").first()).toBeVisible();
    await expect(card.getByText(/a different owner gives the second confirmation/)).toBeVisible();
    await card.getByText("Technical details").click();
    await expect(card.getByText("Risk level 4 · destructive")).toBeVisible();
    await card.getByRole("button", { name: "OK (needs second person)" }).click();
    await expect(card.getByText("You gave the first approval. A different owner has to give the second confirmation.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Confirm and run" })).toHaveCount(0);

    await page.context().clearCookies();
    await signIn(page, "owner2@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/approvals`);
    const again = page.locator("section", { hasText: "Permanently delete contact c_duplicate" });
    await expect(again.getByText("Approved once by Olivia Owner")).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await again.getByRole("button", { name: "Confirm and run" }).click();
    await page.goto(`/orgs/${seed.orgId}/tasks/${seed.deleteTaskId}`);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("done", { exact: true }).first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
  });

  test("the audit log shows the decisions and exports CSV", async ({ page }) => {
    await signIn(page, "owner@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/audit?action=approval.`);
    await expect(page.getByText("approval.approve").first()).toBeVisible();
    await expect(page.getByText("approval.confirm")).toBeVisible();
    const res = await page.request.get(`/api/orgs/${seed.orgId}/audit.csv`);
    expect(res.status()).toBe(200);
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toBe("seq,at,actor_type,actor_id,action,target,tier,outcome,approval_request_id,metadata,prev_hash,entry_hash");
    expect(csv).toContain("tool.mock.send_email");
  });
});

test.describe.serial("chat and the agent switch", () => {
  test("starting a conversation opens it; a message gets a labelled MOCK reply from the lead bot", async ({ page }) => {
    await signIn(page, "owner@e2e.test");
    // Chat-first: the first message starts the conversation and names it.
    await page.goto(`/orgs/${seed.orgId}/chat`);
    await page.getByLabel("Ask Scout to do something").fill("E2E check-in");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "E2E check-in" })).toBeVisible();
    await page.getByLabel("Message Scout").fill("hello there");
    await page.getByLabel("Message Scout").press("Enter");
    await expect(page.getByText("You", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^MOCK lead bot: I couldn't tell/).first()).toBeVisible();
  });

  test("an owner pauses all agents: banner everywhere and the lead bot hands nothing off; then resumes", async ({ page }) => {
    await signIn(page, "owner@e2e.test");
    await page.goto(`/orgs/${seed.orgId}/settings`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Pause all agents" }).click();
    await expect(page.getByText("Agents are paused.", { exact: false }).first()).toBeVisible();
    await page.goto(`/orgs/${seed.orgId}/tasks`);
    await expect(page.getByRole("alert").filter({ hasText: "Agents are paused." })).toBeVisible();
    await page.goto(`/orgs/${seed.orgId}/settings`);
    await page.getByRole("button", { name: "Resume agents" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Agents are paused." })).toHaveCount(0);
  });
});
