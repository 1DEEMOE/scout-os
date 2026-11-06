import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

/**
 * Sidebar v2: five calm items with icons, everything else behind More,
 * a collapsible icon rail, phone tabs plus a More sheet, the Cmd/Ctrl-K
 * palette, and the workspace/profile footer. Keyboard and WCAG 2.2 AA.
 */
const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = evidenceDir("sidebar");
const states = path.resolve(import.meta.dirname, "../test-results");
mkdirSync(states, { recursive: true });
const base = (org = seed.orgId) => `/orgs/${org}`;

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

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on ${where}`).toEqual([]);
}

// Sign in once per role and reuse the session (sign-in is rate limited per IP).
const stateFor: Record<string, string> = {};
test.beforeAll(async ({ browser }, info) => {
  info.setTimeout(180_000);
  for (const email of ["owner@e2e.test", "viewer@e2e.test"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, email);
    stateFor[email] = path.join(states, `sidebar-${email}.json`);
    await ctx.storageState({ path: stateFor[email] });
    await ctx.close();
  }
});
async function open(browser: Browser, email = "owner@e2e.test", viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFor[email], viewport });
  return { ctx, page: await ctx.newPage() };
}

test.describe("sidebar v2", () => {
  test("desktop: five calm items with icons, 44px rows, 8px gaps, one quiet active state", async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.goto(base());
    const nav = page.getByRole("navigation", { name: "Organization" });
    const main = nav.getByRole("list", { name: "Main" });
    const links = main.getByRole("link");
    await expect(links).toHaveCount(5);
    for (const name of ["Today", "Work", "Customers", "Leads"]) await expect(main.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: /^Approvals\s*,\s*\d+ waiting$/ })).toBeVisible();
    const m = await links.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        const label = e.querySelector("span")!;
        return { h: r.height, top: r.top, bottom: r.bottom, icon: !!e.querySelector("svg"), font: parseFloat(getComputedStyle(label).fontSize), border: getComputedStyle(e.parentElement!).borderBottomWidth, current: e.getAttribute("aria-current") };
      }),
    );
    for (const r of m) {
      expect(r.h).toBeGreaterThanOrEqual(44);
      expect(r.icon).toBe(true);
      expect(r.font).toBeGreaterThanOrEqual(15);
      expect(r.font).toBeLessThanOrEqual(16);
      expect(r.border).toBe("0px"); // no dividers between rows
    }
    for (let i = 1; i < m.length; i++) expect(Math.round(m[i]!.top - m[i - 1]!.bottom)).toBe(8);
    expect(m.filter((r) => r.current === "page")).toHaveLength(1); // Today
    await page.screenshot({ path: path.join(shots, "desktop-sidebar.png") });
    await axe(page, "sidebar (collapsed More)");
    await ctx.close();
  });

  test("More: everything else behind progressive disclosure, closed by default, remembered", async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.goto(base());
    const nav = page.getByRole("navigation", { name: "Organization" });
    const more = nav.getByRole("button", { name: "More" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(nav.getByRole("link", { name: "Invoices" })).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const groups = nav.getByRole("list", { name: "More" }).getByRole("button");
    await expect(groups).toHaveText(["Teammates & routines", "Library", "Workspace"]);
    for (const g of await groups.all()) await expect(g).toHaveAttribute("aria-expanded", "false"); // secondary sections start closed
    await nav.getByRole("button", { name: "Workspace" }).click();
    for (const name of ["Settings", "Team", "Integrations", "Front desk", "Plan & billing", "Audit log", "Guided setup"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "Library" }).click();
    for (const name of ["Conversations", "Invoices"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(shots, "desktop-more-open.png") });
    await axe(page, "sidebar (More open)");
    // Open/closed state survives a reload.
    await page.reload();
    await expect(nav.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("button", { name: "Teammates & routines" })).toHaveAttribute("aria-expanded", "false");
    await nav.getByRole("button", { name: "More" }).click();
    await page.reload();
    await expect(nav.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    // On a page that lives under More, its group opens itself so you can see where you are.
    await page.goto(base() + "/billing");
    await expect(nav.getByRole("link", { name: "Plan & billing" })).toHaveAttribute("aria-current", "page");
    await ctx.close();
  });

  test("icon rail: collapses, keeps names and tooltips, remembered with no flash, Ctrl+\\ toggles", async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.goto(base());
    const aside = page.locator("#sidebar");
    const wide = (await aside.boundingBox())!.width;
    expect(wide).toBeGreaterThan(250);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThanOrEqual(96);
    const main = page.getByRole("navigation", { name: "Organization" }).getByRole("list", { name: "Main" });
    // Still five named links; each 44px+ square-ish target.
    await expect(main.getByRole("link")).toHaveCount(5);
    const work = main.getByRole("link", { name: "Work", exact: true });
    const box = (await work.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    // The label shows as a tooltip on keyboard focus.
    await work.focus();
    await expect.poll(() => work.locator("span").first().evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
    await page.screenshot({ path: path.join(shots, "desktop-rail.png") });
    await axe(page, "icon rail");
    // Remembered, and applied before first paint (no wide-then-narrow flash).
    await page.addInitScript(() =>
      document.addEventListener("DOMContentLoaded", () => {
        const w = window as unknown as { __railAtParse: { rail?: string; width: number } };
        w.__railAtParse = { rail: document.documentElement.dataset.rail, width: document.getElementById("sidebar")!.getBoundingClientRect().width };
      }),
    );
    await page.reload();
    const atParse = await page.evaluate(() => (window as unknown as { __railAtParse: { rail?: string; width: number } }).__railAtParse);
    expect(atParse.rail).toBe("1");
    expect(atParse.width).toBeLessThanOrEqual(96);
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    // More in the rail expands the sidebar with More open.
    await page.getByRole("navigation", { name: "Organization" }).getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(page.getByRole("list", { name: "More" })).toBeVisible();
    await page.keyboard.press("Control+Backslash");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.keyboard.press("Control+Backslash");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await ctx.close();
  });

  test("footer: one calm row with workspace switcher and profile; sign out lives in the profile menu at 44px+", async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.goto(base());
    const ws = page.getByRole("button", { name: /switch workspace$/ });
    const profile = page.getByRole("button", { name: "Profile" });
    const [a, b] = [(await ws.boundingBox())!, (await profile.boundingBox())!];
    expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(4); // same row
    expect(b.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0); // not loose in the sidebar
    await ws.click();
    const wsPanel = page.getByRole("group", { name: "Switch workspace" });
    await expect(wsPanel.getByRole("link", { name: /E2E Bookkeeping/ })).toHaveAttribute("aria-current", "page");
    await expect(wsPanel.getByRole("link", { name: /E2E Roofing/ })).toBeVisible();
    await expect(wsPanel.getByRole("link", { name: "All workspaces" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(wsPanel).toHaveCount(0);
    await expect(ws).toBeFocused();
    // Keyboard: open the profile menu with Enter.
    await profile.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("group", { name: "Profile" });
    await expect(menu.getByText("owner@e2e.test")).toBeVisible();
    const signOut = menu.getByRole("button", { name: "Sign out" });
    await expect.poll(async () => (await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(44); // after the open motion settles
    await expect(menu.getByRole("group", { name: "Theme" })).toBeVisible();
    await page.screenshot({ path: path.join(shots, "desktop-profile-menu.png") });
    await axe(page, "profile menu");
    await page.mouse.click(900, 450); // outside closes
    await expect(menu).toHaveCount(0);
    await ctx.close();
  });

  test("phone: same five tabs with icons, and a More sheet with every other page", async ({ browser }) => {
    const { ctx, page } = await open(browser, "owner@e2e.test", { width: 390, height: 844 });
    await page.goto(base());
    const tabs = page.getByRole("navigation", { name: "Primary" });
    const links = tabs.getByRole("link");
    await expect(links).toHaveCount(5);
    for (const [i, name] of ["Today", "Approvals", "Work", "Customers", "Leads"].entries()) await expect(links.nth(i)).toHaveAccessibleName(new RegExp(`^${name}`));
    for (const l of await links.all()) {
      expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(l.locator("svg")).toHaveCount(1);
    }
    const moreBtn = page.getByRole("button", { name: "More", exact: true });
    await moreBtn.click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await sheet.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(sheet.getByRole("link", { name: "Plan & billing" })).toBeVisible();
    const signOut = sheet.getByRole("button", { name: "Sign out" });
    expect((await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: path.join(shots, "phone-more-sheet.png") });
    await axe(page, "More sheet (phone)");
    // Focus stays inside the sheet.
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(moreBtn).toBeFocused();
    // A sheet link navigates and closes it.
    await moreBtn.click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Plan & billing" }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole("dialog", { name: "More" })).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, "phone-tabs.png") });
    await ctx.close();
  });

  test("Cmd/Ctrl-K palette: every page and action, keyboard only", async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.goto(base());
    await page.locator("body").click({ position: { x: 900, y: 120 } });
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole("combobox", { name: "Search pages and actions" });
    await expect(box).toBeFocused();
    // Every sidebar destination is in the palette, plus actions.
    for (const name of ["Today", "Approvals", "Work", "Customers", "Leads", "Conversations", "Invoices", "Settings", "Team", "Integrations", "Front desk", "Plan & billing", "Audit log", "Guided setup", "Help & install", "New chat with Scout", "Sign out"]) {
      await expect(dialog.getByRole("option", { name, exact: true })).toHaveCount(1);
    }
    await page.screenshot({ path: path.join(shots, "palette-open.png") });
    await axe(page, "command palette");
    await box.fill("invoice");
    await expect(dialog.getByRole("option").first()).toHaveText("Invoices");
    await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    const second = dialog.getByRole("option").nth(1);
    if (await second.count()) await expect(second).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/finance$/);
    await expect(dialog).toHaveCount(0);
    // Escape closes and returns focus where it was.
    const search = page.locator("#sidebar").getByRole("button", { name: "Search" });
    await search.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(search).toBeFocused();
    // Actions run too: collapse the sidebar from the palette.
    await page.keyboard.press("Meta+k");
    await expect(dialog).toBeVisible();
    await box.fill("collapse");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await box.fill("dark theme");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await page.keyboard.press("Control+k");
    await box.fill("zzzz no such page");
    await expect(dialog.getByText(/Nothing matches/)).toBeVisible();
    await ctx.close();
  });

  test("palette and sidebar respect roles: a viewer is never offered pages they can't open", async ({ browser }) => {
    const { ctx, page } = await open(browser, "viewer@e2e.test");
    await page.goto(base(seed.scoutOrgId));
    const nav = page.getByRole("navigation", { name: "Organization" });
    await nav.getByRole("button", { name: "More" }).click();
    for (const g of ["Library", "Workspace"]) await nav.getByRole("button", { name: g }).click();
    await expect(nav.getByRole("link", { name: /^(Scout|Analytics|Audit log)$/ })).toHaveCount(0);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    for (const name of ["Scout", "Analytics", "Audit log", "New chat with Scout"]) await expect(dialog.getByRole("option", { name, exact: true })).toHaveCount(0);
    await ctx.close();
  });

  test("phone: the search button opens the same palette", async ({ browser }) => {
    const { ctx, page } = await open(browser, "owner@e2e.test", { width: 390, height: 844 });
    await page.goto(base());
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await dialog.getByRole("combobox").fill("front desk");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/front-desk$/);
    await ctx.close();
  });

  test("keyboard: skip link, visible focus on every sidebar control", async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.goto(base());
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    const missing: string[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const s = getComputedStyle(el);
        return { name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30), ok: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2, inSidebar: !!el.closest("#sidebar") };
      });
      if (r.inSidebar && !r.ok) missing.push(r.name);
    }
    expect(missing).toEqual([]);
    await page.keyboard.press("Shift+Tab");
    await ctx.close();
  });
});
