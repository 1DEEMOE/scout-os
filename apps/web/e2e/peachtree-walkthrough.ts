/**
 * Playwright walkthrough of the Peachtree Roofing SAMPLE org.
 * Desktop (1280) with video + phone (390). Numbered screenshots 01–10.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

const OUT = process.env.DEMO_DIR ? path.resolve(path.resolve(import.meta.dirname, "../../.."), process.env.DEMO_DIR) : evidenceDir("demo");
const BASE = process.env.BETTER_AUTH_URL || "http://localhost:3800";
const seed = JSON.parse(readFileSync(path.join(OUT, "seed-info.json"), "utf8")) as {
  orgId: string;
  jobId: string;
  email: string;
  password: string;
};
const org = seed.orgId;
const jobId = seed.jobId;
const notes: Array<{ step: string; viewport: string; title: string; overflowX: boolean; width: number; scrollWidth: number; errors: string[]; url: string }> = [];

mkdirSync(path.join(OUT, "desktop"), { recursive: true });
mkdirSync(path.join(OUT, "mobile"), { recursive: true });
mkdirSync(path.join(OUT, "video-raw"), { recursive: true });

async function signIn(page: Page) {
  for (let attempt = 0; ; attempt++) {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(seed.email);
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await page.waitForURL(/\/orgs/, { timeout: 8_000 });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      await page.waitForTimeout(11_000);
    }
  }
}

async function shot(page: Page, viewport: "desktop" | "mobile", step: string) {
  const file = path.join(OUT, viewport, `${step}.png`);
  await page.waitForTimeout(400);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const metrics = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    return {
      title: h1?.textContent?.trim() || document.title,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  await page.screenshot({ path: file, fullPage: true });
  notes.push({ step, viewport, ...metrics, errors, url: page.url() });
  return file;
}

async function completeWizard(page: Page) {
  // Industry screen already screenshot; now walk the rest.
  await page.getByRole("button", { name: /Roofing/ }).click();
  await page.getByRole("heading", { name: "Business basics" }).waitFor({ timeout: 20_000 });
  const zip = page.getByLabel("Service-area ZIP");
  await zip.fill("30303");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Get to first value" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("heading", { name: "Connect tools later" }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: /Invite your crew/ }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("heading", { name: /Generate your first Morning Briefing/ }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: /Finish & open briefing/ }).click();
  await page.waitForURL(/\/routines\/briefing/, { timeout: 90_000 });
  await page.getByRole("heading").first().waitFor({ timeout: 20_000 });
}

const CAPTIONS: Record<string, { title: string; caption: string }> = {
  "01-setup-wizard": {
    title: "1. Setup wizard",
    caption:
      "Jordan opens Scout OS and starts setup for Peachtree Roofing. The wizard asks what kind of business this is — Roofing sets up storm leads, a Morning Briefing, and a Scout Pro trial. Approval rules stay the same.",
  },
  "02-today": {
    title: "2. Home screen (Today)",
    caption:
      "Today is the morning picture: pending decisions, a front-desk booking from an AI assistant, a flagged invoice, overdue bills, and a path into the briefing. The amber banner means this local run is in demo mode — no live AI model and no real payments.",
  },
  "03-morning-briefing": {
    title: "3. Morning briefing",
    caption:
      "Finishing setup generates the first Morning Briefing. It stays in-app and read-only — a snapshot of what needs attention today, built from the SAMPLE Peachtree data.",
  },
  "04-leads-and-scout": {
    title: "4. Leads and Scout",
    caption:
      "Scout matches invented Atlanta homeowners against synthetic storm reports. Every row is marked DEMO / SAMPLE. Scout scores possible jobs and explains the score; it never contacts anyone on its own.",
  },
  "05-one-click-approve": {
    title: "5. Approving an item in one click",
    caption:
      "Approvals land on Today and the Approvals page with a plain OK button. Here Jordan approves SAMPLE: Wayne Cole’s inspection booking in one click. Higher-risk items still need a person; nothing auto-pays.",
  },
  "06-front-desk-booking": {
    title: "6. Front-desk booking request",
    caption:
      "Ava, an AI assistant from Homeowner Helper (SAMPLE), asked to book a roof inspection for Denise Harper. Outside booking requests — people and AI agents — always wait for a person’s OK before they are confirmed.",
  },
  "07-flagged-invoice": {
    title: "7. Flagged invoice",
    caption:
      "An incoming invoice from “SAMPLE: Apex Materials LLC” is flagged: the sender domain doesn’t match, the bank account isn’t on file, the amount is far outside the usual pattern, and the PDF metadata looks edited. Scout OS raises an approval and never pays it automatically.",
  },
  "08-job-photos": {
    title: "8. Job photos and claim packet",
    caption:
      "The Seminole Avenue hail job keeps tamper-evident photos: each file is hashed, chained to the previous one, and stamped with time and GPS. An edited re-upload is flagged. Jordan can download a claim packet that records the chain for an insurer.",
  },
  "08b-claim-packet": {
    title: "8b. Claim packet",
    caption:
      "The claim packet is a printable record of each photo’s SHA-256 hash, previous hash, capture time, GPS, uploader, and integrity status. It shows the chain is intact and calls out the edited file.",
  },
  "09-invoicing": {
    title: "9. Invoicing and getting paid",
    caption:
      "Money · Invoices shows SAMPLE bills from the mock billing system: two overdue, one still open, and one already paid (James Whitaker). Reminders are prepared only after someone taps OK — the system never sends them on its own.",
  },
  "10-team-invite": {
    title: "10. Team invite",
    caption:
      "Settings is where Jordan invites the rest of the crew. Chris Walker is already a member (SAMPLE). Inviting Taylor creates a 7-day sign-up link; if email can’t be sent in this local demo, the link is shown so it can be shared directly.",
  },
};

function writeHtml() {
  const steps = [
    "01-setup-wizard",
    "02-today",
    "03-morning-briefing",
    "04-leads-and-scout",
    "05-one-click-approve",
    "06-front-desk-booking",
    "07-flagged-invoice",
    "08-job-photos",
    "08b-claim-packet",
    "09-invoicing",
    "10-team-invite",
  ];
  const sections = steps
    .map((id) => {
      const meta = CAPTIONS[id]!;
      const desk = `desktop/${id}.png`;
      const phone = `mobile/${id}.png`;
      const hasPhone = existsSync(path.join(OUT, phone));
      const hasDesk = existsSync(path.join(OUT, desk));
      return `<section class="step" id="${id}">
  <h2>${meta.title}</h2>
  <p class="caption">${meta.caption}</p>
  <div class="shots">
    ${hasDesk ? `<figure><img src="${desk}" alt="${meta.title} on desktop"/><figcaption>Desktop (1280)</figcaption></figure>` : ""}
    ${hasPhone ? `<figure class="phone"><img src="${phone}" alt="${meta.title} on a phone"/><figcaption>Phone (390)</figcaption></figure>` : ""}
  </div>
</section>`;
    })
    .join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Peachtree Roofing — Scout OS sample walkthrough</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Georgia, "Times New Roman", serif; max-width: 1120px; margin: 2rem auto 4rem; padding: 0 1.25rem; color: #1b1b1b; line-height: 1.5; }
    header { border-bottom: 1px solid #ddd; padding-bottom: 1.25rem; margin-bottom: 2rem; }
    h1 { font-size: 2rem; margin: 0 0 0.5rem; }
    h2 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    .lede, .note { color: #444; }
    .note { background: #fff7ed; border: 1px solid #fed7aa; padding: 0.85rem 1rem; border-radius: 8px; }
    .step { margin: 2.75rem 0; }
    .caption { font-size: 1.05rem; }
    .shots { display: grid; grid-template-columns: 1fr minmax(220px, 360px); gap: 1rem; align-items: start; }
    @media (max-width: 840px) { .shots { grid-template-columns: 1fr; } }
    figure { margin: 0; }
    img { width: 100%; border: 1px solid #d6d6d6; border-radius: 8px; background: #fafafa; }
    figcaption { font-size: 0.9rem; color: #555; margin-top: 0.35rem; }
    .phone img { max-width: 390px; }
  </style>
</head>
<body>
  <header>
    <h1>Peachtree Roofing — a sample walk through Scout OS</h1>
    <p class="lede">This is a local sample so you can see how the product flows. Every lead, job, invoice, booking and photo is invented and marked SAMPLE or DEMO. Nothing here is a real customer, and nothing was deployed or paid for.</p>
    <p class="note">Local demo server: <a href="${BASE}">${BASE}</a> · Sign in as ${seed.email}. This document is ${path.join(OUT, "walkthrough.html")}.</p>
  </header>
  ${sections}
</body>
</html>`;
  writeFileSync(path.join(OUT, "walkthrough.html"), html);
}

const browser: Browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

// --- Desktop journey (recorded) ---
const desktop = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: path.join(OUT, "video-raw"), size: { width: 1280, height: 900 } },
});
const d = await desktop.newPage();
const video = d.video();
await signIn(d);
await d.goto(`${BASE}/orgs/${org}/setup`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: /Set up Scout OS|What kind of business/ }).first().waitFor({ timeout: 20_000 }).catch(() => {});
await shot(d, "desktop", "01-setup-wizard");

// Mobile wizard screenshot while setup is still incomplete
const mobile1 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const m1 = await mobile1.newPage();
await signIn(m1);
await m1.goto(`${BASE}/orgs/${org}/setup`, { waitUntil: "networkidle" });
await shot(m1, "mobile", "01-setup-wizard");
await mobile1.close();

await completeWizard(d);

await d.goto(`${BASE}/orgs/${org}`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: "Today" }).waitFor({ timeout: 20_000 });
await shot(d, "desktop", "02-today");

await d.goto(`${BASE}/orgs/${org}/routines/briefing`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: /Morning Briefing|Briefing/ }).first().waitFor({ timeout: 20_000 });
await shot(d, "desktop", "03-morning-briefing");

await d.goto(`${BASE}/orgs/${org}/scout`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: "Scout" }).waitFor({ timeout: 20_000 });
await shot(d, "desktop", "04-leads-and-scout");

await d.goto(`${BASE}/orgs/${org}/approvals`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: /Need your OK|Approvals/ }).first().waitFor({ timeout: 20_000 }).catch(() => {});
await shot(d, "desktop", "05-one-click-approve");
// Approve the person booking (Wayne Cole) if the OK button is there.
const wayneOk = d.getByText("Front desk: confirm person booking for SAMPLE: Wayne Cole").locator("xpath=following::button[normalize-space()='OK'][1]");
if (await wayneOk.count()) {
  await wayneOk.click();
  await d.waitForTimeout(1500);
} else {
  throw new Error("Could not find OK for Wayne Cole person booking");
}

await d.goto(`${BASE}/orgs/${org}`, { waitUntil: "networkidle" });
const fd = d.getByText(/Front desk bookings|Denise Harper|Homeowner Helper|Ava/);
if (await fd.count()) await fd.first().scrollIntoViewIfNeeded();
await shot(d, "desktop", "06-front-desk-booking");

const flagged = d.getByText(/Flagged invoices|Apex Materials/);
if (await flagged.count()) await flagged.first().scrollIntoViewIfNeeded();
await shot(d, "desktop", "07-flagged-invoice");

await d.goto(`${BASE}/orgs/${org}/tasks/${jobId}`, { waitUntil: "networkidle" });
await d.getByText(/Job photos|Chain intact|claim packet/i).first().waitFor({ timeout: 20_000 }).catch(() => {});
await shot(d, "desktop", "08-job-photos");

try {
  const html = await d.request.get(`${BASE}/api/orgs/${org}/jobs/${jobId}/claim-packet`);
  const body = await html.text();
  writeFileSync(path.join(OUT, "claim-packet-sample.html"), body);
  await d.setContent(body);
  await shot(d, "desktop", "08b-claim-packet");
} catch (err) {
  notes.push({ step: "08b-claim-packet", viewport: "desktop", title: "claim-packet-failed", overflowX: false, width: 1280, scrollWidth: 1280, errors: [String(err)], url: `${BASE}/api/orgs/${org}/jobs/${jobId}/claim-packet` });
}

await d.goto(`${BASE}/orgs/${org}/finance`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: /Money|Invoices/ }).first().waitFor({ timeout: 20_000 });
await shot(d, "desktop", "09-invoicing");

await d.goto(`${BASE}/orgs/${org}/settings`, { waitUntil: "networkidle" });
await d.getByRole("heading", { name: /Invite someone|Settings/ }).first().waitFor({ timeout: 20_000 }).catch(() => {});
const emailBox = d.locator('form input[name="email"], form input[type="email"]').first();
if (await emailBox.count()) {
  await emailBox.fill("taylor.nguyen@peachtree.example.test");
  const inviteBtn = d.getByRole("button", { name: /Invite|Send invite|Add/ }).first();
  if (await inviteBtn.count()) {
    await inviteBtn.click();
    await d.waitForTimeout(1500);
  }
}
await shot(d, "desktop", "10-team-invite");

await desktop.close();
let videoPath: string | null = null;
if (video) {
  const raw = await video.path();
  const webm = path.join(OUT, "walkthrough-desktop.webm");
  copyFileSync(raw, webm);
  videoPath = webm;
  try {
    execFileSync("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(OUT, "walkthrough-desktop.mp4")], { stdio: "ignore" });
    videoPath = path.join(OUT, "walkthrough-desktop.mp4");
  } catch {
    // ffmpeg missing or convert failed — keep webm
  }
}

// --- Phone recapture of remaining screens (wizard already captured) ---
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const m = await mobile.newPage();
await signIn(m);
const mobilePages: Array<[string, string]> = [
  ["02-today", `${BASE}/orgs/${org}`],
  ["03-morning-briefing", `${BASE}/orgs/${org}/routines/briefing`],
  ["04-leads-and-scout", `${BASE}/orgs/${org}/scout`],
  ["05-one-click-approve", `${BASE}/orgs/${org}/approvals`],
  ["06-front-desk-booking", `${BASE}/orgs/${org}`],
  ["07-flagged-invoice", `${BASE}/orgs/${org}`],
  ["08-job-photos", `${BASE}/orgs/${org}/tasks/${jobId}`],
  ["09-invoicing", `${BASE}/orgs/${org}/finance`],
  ["10-team-invite", `${BASE}/orgs/${org}/settings`],
];
for (const [name, url] of mobilePages) {
  await m.goto(url, { waitUntil: "networkidle" });
  if (name === "06-front-desk-booking") {
    const el = m.getByText(/Front desk bookings|Denise Harper|Homeowner Helper|Ava/);
    if (await el.count()) await el.first().scrollIntoViewIfNeeded();
  }
  if (name === "07-flagged-invoice") {
    const el = m.getByText(/Flagged invoices|Apex Materials/);
    if (await el.count()) await el.first().scrollIntoViewIfNeeded();
  }
  await shot(m, "mobile", name);
}
try {
  const packet = readFileSync(path.join(OUT, "claim-packet-sample.html"), "utf8");
  await m.setContent(packet);
  await shot(m, "mobile", "08b-claim-packet");
} catch {
  /* optional */
}
await mobile.close();
await browser.close();

writeFileSync(path.join(OUT, "screenshot-notes.json"), JSON.stringify(notes, null, 2));
writeHtml();
console.log(JSON.stringify({ ok: true, orgId: org, videoPath, out: OUT, notes: notes.length }, null, 2));
