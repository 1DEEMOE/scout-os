// Captures demo screenshots from a running app (default http://localhost:3100).
import path from "node:path";
import { chromium } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const seed = JSON.parse(process.env.SEED!) as { orgId: string; conversationId: string; taskId: string };
const out = process.env.OUT ? path.resolve(path.resolve(import.meta.dirname, "../../.."), process.env.OUT) : evidenceDir("demo-shots");
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const base = process.env.BASE ?? "http://localhost:3100";
await page.goto(`${base}/sign-in`);
await page.getByLabel("Email").fill("owner@e2e.test");
await page.getByLabel("Password").fill("e2e-password-12345");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(/\/orgs$/);
const o = `${base}/orgs/${seed.orgId}`;
const shots: [string, string][] = [
  ["1-overview", o], ["2-approvals", `${o}/approvals`], ["3-inbox", `${o}/inbox`], ["4-email-and-draft", `${o}/inbox/${seed.conversationId}`],
  ["5-sales", `${o}/sales`], ["6-finance", `${o}/finance`], ["7-agents-and-memory", `${o}/agents`], ["8-billing", `${o}/billing`],
  ["9-audit-log", `${o}/audit`], ["10-task-detail", `${o}/tasks/${seed.taskId}`],
];
for (const [name, url] of shots) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
await browser.close();
