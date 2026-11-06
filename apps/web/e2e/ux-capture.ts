import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const out = process.env.OUT ? path.resolve(path.resolve(import.meta.dirname, "../../.."), process.env.OUT) : evidenceDir("ux");
const base = process.env.BASE || "http://localhost:3700";
const orgId = process.env.ORG_ID!;
const scoutOrgId = process.env.SCOUT_ORG_ID!;
mkdirSync(out, { recursive: true });

const pages: [string, string][] = [
  ["sign-in", "/sign-in"],
  ["orgs", "/orgs"],
  ["overview", `/orgs/${orgId}`],
  ["approvals", `/orgs/${orgId}/approvals`],
  ["tasks", `/orgs/${orgId}/tasks`],
  ["inbox", `/orgs/${orgId}/inbox`],
  ["pipeline", `/orgs/${orgId}/sales`],
  ["finance", `/orgs/${orgId}/finance`],
  ["routines", `/orgs/${orgId}/routines`],
  ["briefing", `/orgs/${orgId}/routines/briefing`],
  ["chat", `/orgs/${orgId}/chat`],
  ["agents", `/orgs/${orgId}/agents`],
  ["billing", `/orgs/${orgId}/billing`],
  ["settings", `/orgs/${orgId}/settings`],
  ["audit", `/orgs/${orgId}/audit`],
  ["scout", `/orgs/${scoutOrgId}/scout`],
  ["scout-signals", `/orgs/${scoutOrgId}/scout/signals`],
  ["scout-contacts", `/orgs/${scoutOrgId}/scout/contacts`],
  ["scout-setup", `/orgs/${scoutOrgId}/scout/setup`],
  ["analytics", `/orgs/${scoutOrgId}/analytics`],
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

async function shot(viewport: { width: number; height: number }, suffix: string) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const first = pages[0];
  if (first && !first[0].includes("skip-login")) {
    await page.goto(`${base}/sign-in`);
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill("e2e-password-12345");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/orgs$/);
  }
  const audit: unknown[] = [];
  for (const [name, path] of pages) {
    // For sign-in page, open a fresh context without auth to avoid redirect
    let p = page;
    let tempCtx = null as Awaited<ReturnType<typeof browser.newContext>> | null;
    if (name === "sign-in") {
      tempCtx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      p = await tempCtx.newPage();
    }
    const res = await p.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(250);
    const file = `${name}-${suffix}.png`;
    await p.screenshot({ path: `${out}/${file}`, fullPage: true });
    const metrics = await p.evaluate(() => {
      const h1 = document.querySelector("h1");
      const nav = document.querySelector('nav[aria-label="Organization"]');
      const allClickables = [...document.querySelectorAll("main a, main button")].filter((el) => (el as HTMLElement).offsetParent !== null);
      const smallText = [...document.querySelectorAll("main *")].filter((el) => {
        const s = getComputedStyle(el);
        const fs = parseFloat(s.fontSize);
        return el.children.length === 0 && !!el.textContent?.trim() && fs > 0 && fs < 14 && s.display !== "none";
      }).length;
      const tables = document.querySelectorAll("main table").length;
      const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
      const jargon = (document.body.innerText.match(/\b(tier|Tier|WAITING_FOR|ESCALATED|awaiting_confirmation|actionDigest|fingerprint)\b/g) || []).slice(0, 20);
      const primaryBtns = [...document.querySelectorAll("main button, main a")].filter((el) => /bg-accent/.test((el as HTMLElement).className));
      return {
        title: h1?.textContent?.trim() || "",
        navItems: nav ? [...nav.querySelectorAll("a")].map((a) => a.textContent?.trim()) : [],
        clickableCount: allClickables.length,
        primaryCount: primaryBtns.length,
        smallTextNodes: smallText,
        tables,
        overflowX,
        jargon,
      };
    });
    audit.push({ page: name, viewport: suffix, status: res?.status(), ...metrics });
    console.log(`ok ${file} status=${res?.status()} clicks=${metrics.clickableCount} small=${metrics.smallTextNodes} overflow=${metrics.overflowX}`);
    if (tempCtx) await tempCtx.close();
  }
  await context.close();
  return audit;
}

const desktop = await shot({ width: 1440, height: 900 }, "desktop");
const phone = await shot({ width: 390, height: 844 }, "phone");
writeFileSync(`${out}/audit.json`, JSON.stringify({ desktop, phone }, null, 2));
console.log("DONE", out);
await browser.close();
