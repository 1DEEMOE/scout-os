import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = path.resolve(import.meta.dirname, "../../../docs/plans/evidence/chat-first");
mkdirSync(shots, { recursive: true });

async function signIn(page: Page, email = "owner@e2e.test") {
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

/** WCAG 2.2 AA via axe: contrast, target size (2.5.8), names, landmarks. */
async function expectAccessible(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const problems = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(problems, `axe on ${where}`).toEqual([]);
}

const base = () => `/orgs/${seed.orgId}`;

test.describe("chat-first Scout OS", () => {
  test("Today is a conversation: briefing as a message, approvals inline, a composer that starts a thread", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    await page.goto(base());

    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    const transcript = page.getByRole("list", { name: "Today with Scout" });
    await expect(transcript).toBeVisible();
    // The briefing is a Scout message (set up, or the offer to set it up).
    await expect(transcript.locator("#briefing")).toContainText(/briefing/i);
    // Approvals arrive inline as cards with the same buttons and rules as the Approvals page.
    const card = transcript.getByRole("article", { name: /^Approval:/ }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/Needs your OK|Needs two people to OK/).first()).toBeVisible();
    await card.getByText("Exact action and expiry").click();
    await expect(card.getByText("Risk level")).toBeVisible();
    // The sidebar is quiet and complete.
    const nav = page.getByRole("navigation", { name: "Organization" });
    for (const name of ["Today", "Conversations", "Inbox", "Customers & deals", "Jobs", "Invoices", "Team & connections", "Front desk"]) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }
    // The count is part of the link's accessible name, not just a coloured dot.
    await expect(nav.getByRole("link", { name: /^Needs your OK\s*,\s*\d+ waiting$/ })).toBeVisible();
    await page.screenshot({ path: path.join(shots, "today-desktop-light.png") });

    // Suggestion chips fill the composer; Enter sends and opens the new thread.
    await page.getByRole("button", { name: "What needs my attention today?" }).click();
    await expect(page.getByLabel("Ask Scout to do something")).toHaveValue("What needs my attention today?");
    await page.getByLabel("Ask Scout to do something").press("Enter");
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "What needs my attention today?" })).toBeVisible();
    const convo = page.getByRole("list", { name: "Conversation" });
    await expect(convo.getByText("You", { exact: true }).first()).toBeVisible();
    await expect(convo.getByText(/^MOCK lead bot:/).first()).toBeVisible();
    await expect(convo.getByText("MOCK").first()).toBeVisible(); // mock replies stay labelled
    await page.screenshot({ path: path.join(shots, "thread-desktop-light.png") });
    expect(errors).toEqual([]);
  });

  test("light and dark themes: switchable, remembered, no flash, AA in both (axe)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    for (const [suffix, label] of [["", "today"], ["/approvals", "approvals"], ["/settings/front-desk", "front-desk"], ["/chat", "chat"]] as const) {
      await page.goto(base() + suffix);
      await expectAccessible(page, `${label} (light)`);
    }
    // Switch to dark from the sidebar; it applies at once and survives a reload.
    await page.goto(base());
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(15, 18, 22)");
    await page.reload();
    // Applied before first paint by the inline boot script, so no light flash.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: path.join(shots, "today-desktop-dark.png") });
    for (const [suffix, label] of [["", "today"], ["/approvals", "approvals"], ["/settings/front-desk", "front-desk"], ["/chat", "chat"]] as const) {
      await page.goto(base() + suffix);
      await expectAccessible(page, `${label} (dark)`);
    }
    // Back to following the system.
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("system dark preference is honoured without any stored choice", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(15, 18, 22)");
    await expectAccessible(page, "sign-in (system dark)");
    await ctx.close();
  });

  test("phone: top bar, drawer with the full sidebar, five bottom tabs, no horizontal scroll", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto(base());
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Today", "Approvals", "Leads", "Jobs", "Briefing"]) await expect(tabs.getByRole("link", { name: label })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(shots, "today-phone-light.png") });

    // Drawer: opens with focus on Close, Escape closes and returns focus to Menu.
    await page.getByRole("button", { name: "Menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await expect(drawer.getByRole("link", { name: /^Needs your OK/ })).toBeVisible();
    await page.screenshot({ path: path.join(shots, "drawer-phone-light.png") });
    await expectAccessible(page, "drawer (phone)");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();

    // A drawer link navigates and closes the drawer.
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Conversations" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Chat/ })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
    await expectAccessible(page, "chat (phone)");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(base());
    await page.screenshot({ path: path.join(shots, "today-phone-dark.png") });
    await expectAccessible(page, "today (phone, system dark)");
  });

  test("keyboard only: skip through the sidebar to the composer and send", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    await page.goto(base());
    const box = page.getByLabel("Ask Scout to do something");
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      if (await box.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(box).toBeFocused();
    // Focus is visible: an outline or ring is drawn on the focused composer area.
    const ring = await page.evaluate(() => {
      const form = document.activeElement!.closest("form")!;
      const s = getComputedStyle(form);
      return s.boxShadow !== "none" || s.outlineStyle !== "none";
    });
    expect(ring).toBe(true);
    await page.keyboard.type("Plan tomorrow's follow-ups");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Keep it short");
    await expect(box).toHaveValue("Plan tomorrow's follow-ups\nKeep it short");
  });

  test("lab performance on Today: CLS <= 0.1, LCP <= 2.5 s, interaction latency <= 200 ms", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number; __lcp: number; __inp: number };
      w.__cls = 0;
      w.__lcp = 0;
      w.__inp = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lcp = Math.max(w.__lcp, e.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__inp = Math.max(w.__inp, e.duration);
      }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    });
    await page.goto(base(), { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Chase overdue invoices" }).click();
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => {
      const w = window as unknown as { __cls: number; __lcp: number; __inp: number };
      return { cls: w.__cls, lcp: w.__lcp, inp: w.__inp };
    });
    console.log("lab metrics (Today)", JSON.stringify(metrics));
    expect(metrics.cls).toBeLessThanOrEqual(0.1);
    expect(metrics.lcp).toBeLessThanOrEqual(2500);
    expect(metrics.inp).toBeLessThanOrEqual(200);
  });
});
