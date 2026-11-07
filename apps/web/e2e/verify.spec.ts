import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

// Independent verification pass: every nav page for each role, plus key flows.
const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = process.env.VERIFY_SHOTS ? path.resolve(path.resolve(import.meta.dirname, "../../.."), process.env.VERIFY_SHOTS) : evidenceDir("verify");
const NAV = ["", "/scout", "/scout/signals", "/scout/contacts", "/scout/setup", "/routines", "/routines/briefing", "/chat", "/approvals", "/tasks", "/inbox", "/sales", "/finance", "/analytics", "/agents", "/audit", "/recovery", "/billing", "/settings"];

async function signIn(page: Page, email: string, password = seed.password) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try { await expect(page).toHaveURL(/\/orgs$/, { timeout: 5000 }); return; }
    catch (err) { if (attempt >= 4) throw err; await page.waitForTimeout(11_000); }
  }
}

function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    // Resource failures are recorded with their URL by the response handler below.
    if (m.text().startsWith("Failed to load resource")) return;
    problems.push(`console.${m.type()} ${m.text()}`);
  });
  page.on("response", (r) => {
    // 402 is the expected answer to an import over the plan allowance (asserted in the test).
    if (r.status() === 402 && r.url().includes("scout.importProspects")) return;
    // The sign-in rate limit (429) is expected while signIn() retries.
    if (r.status() === 429 && r.url().includes("/api/auth/sign-in")) return;
    if (r.status() >= 400 && !r.request().isNavigationRequest()) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
  });
  return problems;
}

for (const [email, role, orgs] of [
  ["owner@e2e.test", "owner", [seed.orgId, seed.scoutOrgId]],
  ["sam@e2e.test", "member", [seed.orgId, seed.scoutOrgId]],
  ["viewer@e2e.test", "viewer", [seed.orgId, seed.scoutOrgId]],
] as const) {
  test(`every nav page loads for ${role}`, async ({ page }) => {
    test.setTimeout(180_000);
    mkdirSync(shots, { recursive: true });
    await signIn(page, email);
    const problems = watch(page);
    const results: string[] = [];
    for (const orgId of orgs) {
      for (const p of NAV) {
        const res = await page.goto(`/orgs/${orgId}${p}`);
        const status = res?.status() ?? 0;
        results.push(`${status} ${p || "/"}`);
        // Hidden-by-role pages answer 404 by design; anything else must be 200.
        expect([200, 404], `${role} ${p}`).toContain(status);
        if (role === "viewer" && (p === "/audit" || p.startsWith("/scout") || p === "/analytics")) expect(status, `${role} ${p}`).toBe(404);
        if (role === "viewer") await expect(page.getByRole("navigation", { name: "Organization" }).getByRole("link", { name: /^(Scout|Analytics|Audit log|Recovery)$/ })).toHaveCount(0);
        if (status === 200) {
          await expect(page.getByText(/Application error|Something went wrong|Internal Server Error/i)).toHaveCount(0);
          await expect(page.getByRole("heading").first()).toBeVisible();
        }
        if (orgId === seed.scoutOrgId || role === "owner")
          await page.screenshot({ path: path.join(shots, `${role}-${orgId === seed.scoutOrgId ? "scout" : "main"}${p.replaceAll("/", "-") || "-overview"}.png`), fullPage: true });
      }
    }
    console.log(`${role}: ${results.join(", ")}`);
    expect(problems).toEqual([]);
  });
}

test("sign up, owner invites the new person, sign out ends the session", async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await (await browser.newContext()).newPage();
  const problems = watch(a);
  await a.goto("/sign-up");
  await a.getByLabel("Name").fill("Nina New");
  await a.getByLabel("Email").fill("nina@e2e.test");
  await a.getByLabel("Password").fill("nina-password-12345");
  await a.getByRole("button", { name: /Sign up|Create account/ }).click();
  await expect(a).toHaveURL(/\/orgs$/);
  await expect(a.getByText("not in any organization")).toBeVisible();
  const o = await (await browser.newContext()).newPage();
  await signIn(o, "owner@e2e.test");
  await o.goto(`/orgs/${seed.orgId}/settings`);
  await o.getByPlaceholder("name@company.com").fill("nina@e2e.test");
  await o.getByRole("button", { name: /^Invite/ }).click();
  // Nina already has an account, so the invite adds her directly.
  await expect(o.getByText("nina@e2e.test added.")).toBeVisible();
  await a.reload();
  await expect(a.getByText("E2E Bookkeeping (synthetic)")).toBeVisible();
  await a.getByRole("button", { name: "Sign out" }).click();
  await expect(a).toHaveURL(/\/sign-in/);
  await a.goto("/orgs");
  await expect(a).toHaveURL(/\/sign-in/);
  const res = await a.goto(`/orgs/${seed.orgId}/tasks`);
  expect(res?.url()).toMatch(/sign-in/);
  expect(problems).toEqual([]);
});

test("member creates a task; second owner rejects a pending tier-2 request", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "sam@e2e.test");
  const problems = watch(page);
  await page.goto(`/orgs/${seed.orgId}/tasks`);
  await page.locator("textarea[name=intent]").fill("Draft replies to this week's billing questions");
  await page.getByRole("button", { name: "Send to agents" }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
  await expect(page.getByText("Draft replies to this week's billing questions").first()).toBeVisible();
  await page.context().clearCookies();
  await signIn(page, "owner2@e2e.test");
  await page.goto(`/orgs/${seed.orgId}/approvals`);
  const card = page.locator("section", { hasText: "Email bank@example.test: New account" }).last();
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("section", { hasText: "Recently decided" })).toContainText("Email bank@example.test: New account");
  await page.goto(`/orgs/${seed.orgId}/audit`);
  await expect(page.getByText(/reject/i).first()).toBeVisible();
  await page.goto(`/orgs/${seed.orgId}/routines`);
  await page.getByRole("button", { name: "Pause" }).first().click();
  await expect(page.getByRole("button", { name: "Resume" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).first().click();
  await expect(page.getByRole("button", { name: "Pause" }).first()).toBeVisible();
  await page.goto(`/orgs/${seed.orgId}/billing`);
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("scout: 5,000-row prospect import, then do-not-contact", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@e2e.test");
  const problems = watch(page);
  await page.goto(`/orgs/${seed.scoutOrgId}/scout/setup`);
  const csv = (n: number, tag: string) => {
    const rows = ["name,email,phone,address,city,county,state,zip,ssn"];
    for (let i = 0; i < n; i++) rows.push(`Person ${i},${tag}${i}@bulk.test,555-01${String(i % 100).padStart(2, "0")},${i} Elm St,Plano,Collin,TX,75023,000-00-0000`);
    return Buffer.from(rows.join("\n"));
  };
  const submit = async (buffer: Buffer) => {
    await page.locator("input[name=file]").last().setInputFiles({ name: "bulk.csv", mimeType: "text/csv", buffer });
    await page.locator("input[name=label]").fill("Verify bulk list");
    await page.locator("textarea[name=usageRights]").fill("Synthetic verification data, our own test list.");
    await page.locator("input[name=attest]").check();
    await page.getByRole("button", { name: "Import prospects" }).click();
  };
  // DEMO seed rows do not burn scout.prospect_rows, so the full 5,000/month allowance remains.
  // 5,000 is also the per-file maximum; a full-allowance import must succeed, then one more must fail.
  await submit(csv(5000, "p"));
  const status = page.getByRole("status").filter({ hasText: "Added" });
  await expect(status).toBeVisible({ timeout: 90_000 });
  await expect(status).toContainText("Added 5000");
  await expect(status).toContainText("ssn");
  console.log(`5000-row import: ${await status.textContent()}`);
  await page.screenshot({ path: path.join(shots, "flow-import-5000.png"), fullPage: true });
  await page.reload();
  await submit(csv(1, "r"));
  const over = page.getByRole("alert").filter({ hasText: /./ }).first();
  await expect(over).toBeVisible({ timeout: 30_000 });
  await expect(over).toContainText(/used up|allowance/i);
  console.log(`over-allowance import: ${await over.textContent()}`);
  await page.goto(`/orgs/${seed.scoutOrgId}/scout/contacts`);
  await page.locator("input[name=email]").first().fill("p7@bulk.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("p7@bulk.test").first()).toBeVisible();
  await page.screenshot({ path: path.join(shots, "flow-do-not-contact.png"), fullPage: true });
  expect(problems).toEqual([]);
});
