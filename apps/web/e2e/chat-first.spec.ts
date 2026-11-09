import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = evidenceDir("chat-first");

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
    await expect(card.getByText("Approval level")).toBeVisible();
    // The sidebar is calm: five primary destinations; the rest waits behind "More".
    const nav = page.getByRole("navigation", { name: "Organization" });
    await expect(nav.getByRole("list", { name: "Main" }).getByRole("link")).toHaveCount(5);
    for (const name of ["Today", "Work", "Customers", "Leads"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    // The count is part of the link's accessible name, not just a coloured dot.
    await expect(nav.getByRole("link", { name: /^Approvals\s*,\s*\d+ waiting$/ })).toBeVisible();
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

  test("Today leads with a generated morning briefing; setup is a slim card you can hide", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    await page.goto(`/orgs/${seed.scoutOrgId}`);
    const transcript = page.getByRole("list", { name: "Today with Scout" });
    const first = transcript.locator(":scope > li").first();
    await expect(first).toHaveAttribute("id", "briefing");
    await expect(first).toContainText("Here's your briefing.");
    await expect(first.getByRole("heading", { name: /Storm signals and top prospects \(\d+\)/ })).toBeVisible();
    await expect(first.getByRole("link", { name: "Open the full briefing" })).toBeVisible();
    // Setup is a slim card above the composer, not the first message.
    const setup = page.getByRole("region", { name: "Setup progress" });
    await expect(setup).toBeVisible();
    expect((await setup.boundingBox())!.height).toBeLessThanOrEqual(140);
    await expect(transcript.getByText(/finish setting up/i)).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, "today-briefing-desktop.png") });
    await setup.getByRole("button", { name: "Hide" }).click();
    await expect(setup).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Setup progress" })).toHaveCount(0); // stays hidden in this browser
  });

  test("phone Today: clear priority, secondary updates collapsed, generous spacing, comfortable targets", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto(base());
    const transcript = page.getByRole("list", { name: "Today with Scout" });
    // Briefing first; at most two approval cards before "Show N more".
    await expect(transcript.locator(":scope > li").first()).toHaveAttribute("id", "briefing");
    const shown = transcript.getByRole("article", { name: /^Approval:/ });
    const visible = await shown.evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0 && (e as HTMLElement).offsetParent !== null).length);
    expect(visible).toBeLessThanOrEqual(2);
    const total = await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Approvals/ }).textContent();
    if (await shown.count() > 2) await expect(transcript.getByText(/^Show \d+ more$/)).toBeVisible();
    expect(total).toBeTruthy();
    // Secondary updates are collapsed one-liners.
    const also = page.getByRole("list", { name: "Also today" });
    if (await also.count()) {
      const opened = await also.locator("details[open]").count();
      expect(opened).toBe(0);
    }
    // Generous rhythm between Scout's messages.
    const gap = await transcript.evaluate((el) => parseFloat(getComputedStyle(el).rowGap));
    expect(gap).toBeGreaterThanOrEqual(32);
    // Primary actions on the phone are at least 44px tall.
    for (const loc of [page.getByRole("button", { name: "Send" }), page.getByRole("button", { name: "More", exact: true }), ...(await transcript.getByRole("button", { name: /^OK/ }).all())]) {
      if (await loc.isVisible()) expect((await loc.boundingBox())!.height, await loc.textContent() ?? "").toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: path.join(shots, "today-phone-priority.png"), fullPage: true });
  });

  test("every visible target on key screens is at least 24 by 24 px (WCAG 2.5.8)", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const small: string[] = [];
    for (const vp of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(vp);
      for (const suffix of ["", "/approvals", "/chat", "/settings/front-desk"]) {
        await page.goto(base() + suffix);
        await page.waitForLoadState("networkidle");
        // Open every collapsed part so its contents are measured too.
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
        const found = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("a[href], button, summary, input:not([type=hidden]), select, textarea")]
            .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only") && el.offsetParent !== null)
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ el, r }) => (r.height < 24 || r.width < 24) && !(el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && r.height >= 16))
            .map(({ el, r }) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`),
        );
        small.push(...found.map((f) => `${vp.width}px ${suffix || "/"}: ${f}`));
      }
    }
    expect(small).toEqual([]);
  });

  test("light and dark themes: switchable, remembered, no flash, AA in both (axe)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    for (const [suffix, label] of [["", "today"], ["/approvals", "approvals"], ["/settings/front-desk", "front-desk"], ["/chat", "chat"]] as const) {
      await page.goto(base() + suffix);
      await expectAccessible(page, `${label} (light)`);
    }
    // Switch to dark from the profile menu; it applies at once and survives a reload.
    await page.goto(base());
    await page.getByRole("button", { name: "Profile" }).click();
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(16, 14, 20)");
    await page.reload();
    // Applied before first paint by the inline boot script, so no light flash.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: path.join(shots, "today-desktop-dark.png") });
    for (const [suffix, label] of [["", "today"], ["/approvals", "approvals"], ["/settings/front-desk", "front-desk"], ["/chat", "chat"]] as const) {
      await page.goto(base() + suffix);
      await expectAccessible(page, `${label} (dark)`);
    }
    // Back to following the system.
    await page.getByRole("button", { name: "Profile" }).click();
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("system dark preference is honoured without any stored choice", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(16, 14, 20)");
    await expectAccessible(page, "sign-in (system dark)");
    await ctx.close();
  });

  test("phone: five bottom tabs, no horizontal scroll, AA in light and dark", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto(base());
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Today", "Approvals", "Work", "Customers", "Leads"]) await expect(tabs.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(shots, "today-phone-light.png") });
    await expectAccessible(page, "today (phone)");
    await page.goto(base() + "/chat");
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
    await page.getByRole("button", { name: "Profile" }).click();
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
