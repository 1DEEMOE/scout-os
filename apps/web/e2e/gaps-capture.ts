import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = process.env.OUT!;
const base = process.env.BASE!;
const orgId = process.env.ORG_ID!;
const scoutOrgId = process.env.SCOUT_ORG_ID!;
mkdirSync(out, { recursive: true });

const pages: [string, string][] = [
  ["overview", `/orgs/${orgId}`],
  ["approvals", `/orgs/${orgId}/approvals`],
  ["tasks", `/orgs/${orgId}/tasks`],
  ["briefing", `/orgs/${orgId}/routines/briefing`],
  ["scout", `/orgs/${scoutOrgId}/scout`],
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

async function shot(viewport: { width: number; height: number }, suffix: string) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  for (let a = 0; ; a++) {
    await page.goto(`${base}/sign-in`);
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill("e2e-password-12345");
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await page.waitForURL(/\/orgs$/, { timeout: 5000 });
      break;
    } catch (e) {
      if (a >= 4) throw e;
      await page.waitForTimeout(11000);
    }
  }
  for (const [name, path] of pages) {
    const res = await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const file = `${name}-${suffix}.png`;
    await page.screenshot({ path: `${out}/${file}`, fullPage: true });
    const primary = await page.getByRole("navigation", { name: "Primary" }).count();
    console.log(`ok ${file} status=${res?.status()} primaryNav=${primary}`);
  }
  await context.close();
}

await shot({ width: 1440, height: 900 }, "desktop");
await shot({ width: 390, height: 844 }, "phone");
console.log("DONE", out);
await browser.close();
