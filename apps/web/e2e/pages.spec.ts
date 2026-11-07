import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = evidenceDir("pages");

// Every page renders for the owner without a server error, and has its heading.
const PAGES: [string, string][] = [
  ["", "Today"], ["/approvals", "Needs your OK"], ["/tasks", "Tasks"], ["/inbox", "Inbox"], ["/sales", "Customers & Deals"],
  ["/finance", "Money · Invoices"], ["/agents", "AI workforce"], ["/audit", "Audit log"], ["/billing", "Billing"], ["/settings", "Settings"], ["/chat", "Chat"],
  ["/first-run", "Your first 10 minutes"], ["/activity", "Activity"], ["/memory", "What Scout knows"], ["/opportunities", "Opportunities"],
  ["/goals", "This week"], ["/library", "Library"], ["/settings/notifications", "Notifications"], ["/settings/money", "Money digest"],
  ["/scout", "Scout"], ["/analytics", "Analytics"],
];

test("every org page renders", async ({ page }) => {
  // Sign-in is rate limited per IP (a few per 10 s) and other specs just signed in: retry after the window.
  test.setTimeout(150_000);
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 5000 });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await page.waitForTimeout(11_000);
    }
  }
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [suffix, heading] of PAGES) {
    const id = suffix.startsWith("/scout") || suffix === "/analytics" ? seed.scoutOrgId : seed.orgId;
    const res = await page.goto(`/orgs/${id}${suffix}`);
    expect(res?.status(), suffix).toBe(200);
    expect(res?.headers()["x-frame-options"], suffix).toBe("DENY");
    expect(res?.headers()["content-security-policy"], suffix).toContain("frame-ancestors 'none'");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await page.screenshot({ path: path.join(shots, `page${suffix.replace("/", "-") || "-overview"}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
  await expect(page).toHaveTitle(/Scout OS/);
});
