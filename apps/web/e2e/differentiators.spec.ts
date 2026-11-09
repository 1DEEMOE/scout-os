import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The five differentiators, end to end in a browser:
 * 1 opportunity finder + owner-approved first message, 2 visible levels and
 * owner-only holds, 3 claim packet PDF, 4 (setup in <10 min: plug-and-play.spec),
 * 5 AI visibility check + booking endpoint for AI assistants (still approval-gated).
 */
const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { orgId: string; scoutOrgId: string; password: string };
const shots = path.resolve(import.meta.dirname, "../../../docs/plans/evidence/differentiators");
mkdirSync(shots, { recursive: true });
const states = path.resolve(import.meta.dirname, "../test-results");
mkdirSync(states, { recursive: true });
const scout = `/orgs/${seed.scoutOrgId}`;
const main = `/orgs/${seed.orgId}`;
// A real 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

let ownerState = "";
test.beforeAll(async ({ browser }, info) => {
  info.setTimeout(120_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  for (let attempt = 0; ; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("owner@e2e.test");
    await page.getByLabel("Password").fill(seed.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/orgs$/, { timeout: 5000 });
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(11_000);
    }
  }
  ownerState = path.join(states, "differentiators-owner.json");
  await ctx.storageState({ path: ownerState });
  await ctx.close();
});
const owner = async (browser: Browser, viewport = { width: 1366, height: 900 }) => (await browser.newContext({ storageState: ownerState, viewport })).newPage();

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on ${where}`).toEqual([]);
}

test.describe("differentiators", () => {
  test("1. opportunity finder → drafted first message → owner-only, level 2 approval", async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await owner(browser);
    await page.goto(`${scout}/scout`);
    const finder = page.getByRole("region", { name: /Find local jobs/ });
    await expect(finder.getByText("MOCK").first()).toBeVisible();
    await finder.getByRole("button", { name: "Find jobs near me" }).click();
    const sources = finder.getByRole("list", { name: "Sources checked" });
    await expect(sources).toBeVisible({ timeout: 30_000 });
    await expect(sources.getByText(/Storm reports \(MOCK\)/)).toBeVisible();
    await expect(sources.getByText(/Building permits \(MOCK\)/)).toBeVisible();
    await page.screenshot({ path: path.join(shots, "1-finder.png"), fullPage: true });
    await axe(page, "Scout with finder results");

    // Open a permit-based lead that has an email (the mock feed gives every other owner one).
    await page.reload();
    const lead = page.getByRole("link", { name: /^(Avery|Jordan|Riley|Morgan|Casey|Taylor|Quinn|Reese|Drew|Parker) .+\(DEMO\)$/ }).first();
    await expect(lead).toBeVisible();
    let found = false;
    for (const l of (await page.getByRole("link", { name: /\(DEMO\)$/ }).all()).slice(0, 12)) {
      const href = await l.getAttribute("href");
      if (!href) continue;
      const p2 = await (await browser.newContext({ storageState: ownerState })).newPage();
      await p2.goto(href);
      const card = p2.getByRole("region", { name: "First message" });
      if ((await card.count()) && (await card.locator("p", { hasText: /^To:/ }).count())) {
        found = true;
        await page.goto(href);
        await p2.context().close();
        break;
      }
      await p2.context().close();
    }
    expect(found).toBe(true);
    const card = page.getByRole("region", { name: "First message" });
    await expect(card.getByText("Level 2 · Talks to customers")).toBeVisible();
    await expect(card.getByText("Owner only")).toBeVisible();
    await expect(card.getByLabel("Message")).toHaveValue(/reply "stop"/);
    const to = ((await card.locator("p", { hasText: /^To:/ }).textContent()) ?? "").replace("To:", "").trim();
    expect(to).toMatch(/@example\.test$/);
    await page.screenshot({ path: path.join(shots, "2-first-message.png"), fullPage: true });
    await axe(page, "opportunity with first message");

    // Without recorded permission there's no send button, and the card says why.
    if (await card.getByText(/no recorded permission/i).count()) {
      await expect(card.getByRole("button", { name: "Ask an owner to OK this" })).toHaveCount(0);
      const back = page.url();
      await page.goto(`${scout}/scout/contacts`);
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Record permission" }) });
      await form.getByLabel("Email").fill(to);
      await form.getByLabel("Evidence").fill("Past customer: gutter repair, 2024 (e2e)");
      await form.getByRole("button", { name: "Record permission" }).click();
      await expect(page.getByText(to).first()).toBeVisible();
      await page.goto(back);
    }
    await card.getByLabel("Message").fill(`${await card.getByLabel("Message").inputValue()}\n\nP.S. We're local.`);
    await card.getByRole("button", { name: "Ask an owner to OK this" }).click();
    await expect(card.getByText("Waiting for an owner's OK.")).toBeVisible();

    // On Approvals: the level and "Owner only" are visible, and the legend explains all five levels.
    await page.goto(`${scout}/approvals`);
    const ap = page.locator("section, article").filter({ hasText: `Send a first email to ${to}` }).first();
    await expect(ap.getByText("Level 2 · Talks to customers").first()).toBeVisible();
    await expect(ap.getByText("Owner only")).toBeVisible();
    await page.getByText("What the approval levels mean").click();
    const legend = page.getByRole("list", { name: "Approval levels" });
    await expect(legend.getByRole("listitem")).toHaveCount(5);
    for (const l of ["Level 0 · Look only", "Level 1 · Internal notes", "Level 2 · Talks to customers", "Level 3 · Money & contracts", "Level 4 · Delete or change access"]) await expect(legend.getByText(l)).toBeVisible();
    await page.screenshot({ path: path.join(shots, "3-approval-owner-only.png"), fullPage: true });
    await axe(page, "approvals with legend");
  });

  test("2. levels everywhere; a suspicious invoice is held for an owner at level 3 and never paid", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await owner(browser);
    await page.goto(`${main}/routines`);
    await expect(page.getByText("Level 0 · Look only").first()).toBeVisible();
    await expect(page.getByText("Level 1 · Internal notes").first()).toBeVisible();
    await page.goto(`${main}/finance`);
    const check = page.locator("section").filter({ has: page.getByRole("heading", { name: "Check an incoming invoice" }) });
    await check.getByLabel("Vendor").fill("Acme Roofing Supply");
    await check.getByLabel("Sent from (email)").fill("billing@acme-supp1y.test");
    await check.getByLabel(/Their usual domain/).fill("acmesupply.test");
    await check.getByLabel("Number").fill(`INV-${Date.now()}`);
    await check.getByLabel("Amount ($)").fill("4,850.00");
    await check.getByLabel(/last 4 digits/).fill("9931");
    await check.getByRole("button", { name: "Check this invoice" }).click();
    const result = check.getByRole("status");
    await expect(result.getByText("Held for an owner's OK")).toBeVisible();
    await expect(result.getByText("Level 3 · Money & contracts")).toBeVisible();
    await expect(result.getByText(/Nothing is paid automatically/)).toBeVisible();
    await expect(page.getByRole("list", { name: "Held invoices" }).getByText("Acme Roofing Supply").first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, "4-invoice-held.png"), fullPage: true });
    await axe(page, "invoices with check");
    await page.goto(`${main}/approvals`);
    const held = page.locator("section, article").filter({ hasText: "Acme Roofing Supply" }).first();
    await expect(held.getByText("Owner only")).toBeVisible();
    await expect(held.getByText("Level 3 · Money & contracts").first()).toBeVisible();
  });

  test("3. claim packet: photo and note hashed into one chain; PDF downloads with a fingerprint", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await owner(browser);
    await page.goto(`${main}/tasks`);
    await page.locator('a[href*="/tasks/"]').first().click();
    const packet = page.locator("section").filter({ has: page.getByRole("heading", { name: "Claim packet" }) });
    await expect(packet).toBeVisible();
    await packet.getByLabel("Add photos").setInputFiles({ name: "north-slope.png", mimeType: "image/png", buffer: PNG });
    await expect(packet.getByRole("list", { name: "Packet items" }).getByText(/Photo/).first()).toBeVisible({ timeout: 20_000 });
    await packet.getByLabel("Add a note").fill("Hail bruising on the north slope, 8 hits per test square.");
    await packet.getByRole("button", { name: "Add note" }).click();
    await expect(packet.getByRole("list", { name: "Packet items" }).getByText(/Note/).first()).toBeVisible({ timeout: 20_000 });
    await expect(packet.getByText(/Chain intact · \d+ photos, \d+ notes/)).toBeVisible();
    const pdfHref = await packet.getByRole("link", { name: "Download PDF" }).getAttribute("href");
    const res = await page.request.get(pdfHref!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect(res.headers()["x-packet-fingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
    await page.screenshot({ path: path.join(shots, "5-claim-packet.png"), fullPage: true });
    await axe(page, "job with claim packet");
  });

  test("5a. AI visibility: run a check, see the score, what to fix, and that it's MOCK", async ({ browser }) => {
    const page = await owner(browser, { width: 390, height: 844 });
    await page.goto(`${scout}/ai-visibility`);
    await expect(page.getByRole("heading", { level: 1, name: "AI visibility" })).toBeVisible();
    await expect(page.getByRole("note").getByText("MOCK")).toBeVisible();
    await page.getByLabel("ZIP").fill("30303");
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/\/ 100/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "What to do next" })).toBeVisible();
    await expect(page.locator("ol li")).toHaveCount(3);
    await page.screenshot({ path: path.join(shots, "6-ai-visibility-phone.png"), fullPage: true });
    await axe(page, "AI visibility (phone)");
  });

  test("5b. AI assistants can discover and call the booking endpoint; requests still wait for approval", async ({ browser, request }) => {
    test.setTimeout(150_000);
    const page = await owner(browser);
    await page.goto(`${scout}/settings/front-desk`);
    await page.getByLabel("Name customers see").fill("E2E Roofing front desk");
    await page.getByRole("button", { name: "Create booking link" }).click();
    const code = page.locator("code").filter({ hasText: "/book/" });
    await expect(code).toBeVisible();
    const link = (await code.textContent())!.trim();
    const token = link.split("/book/")[1]!;
    await page.getByRole("button", { name: "I've saved this link" }).click();
    const tomorrow = new Date(Date.now() + 86_400_000);
    await page.getByLabel("Date").fill(`${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`);
    await page.getByRole("button", { name: "Add time slots" }).click();
    await expect(page.getByText(/Added \d+ slot/)).toBeVisible();
    await expect(page.getByRole("heading", { name: /For AI assistants/ })).toBeVisible();
    await expect(page.getByText("Level 2 · Talks to customers").first()).toBeVisible();

    // The booking page advertises the machine-readable description.
    const booking = await (await browser.newContext()).newPage();
    await booking.goto(link);
    const alt = booking.locator('link[rel="alternate"][type="application/vnd.oai.openapi+json"]');
    await expect(alt).toHaveCount(1);
    const spec = await request.get(`/api/front-desk/${token}/openapi.json`);
    expect(spec.status()).toBe(200);
    const doc = (await spec.json()) as { openapi: string; info: { description: string }; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(["/availability", "/bookings"]);
    expect(doc.info.description).toMatch(/waits for a person at the business to approve/);
    expect((await request.get("/api/front-desk/not-a-real-token-0000/openapi.json")).status()).toBe(404);

    // An assistant books on a customer's behalf.
    const slots = (await (await request.get(`/api/front-desk/${token}/availability`)).json()) as { slots: { id: string }[] };
    expect(slots.slots.length).toBeGreaterThan(0);
    const anon = await request.post(`/api/front-desk/${token}/bookings`, { data: { slotId: slots.slots[0]!.id, requesterKind: "ai_agent", disclosureAck: true, customerName: "Dana Field", customerEmail: "dana@field.test" } });
    expect(anon.status()).toBe(400); // assistants must say who they are
    // Another website's page can't post bookings from a visitor's browser.
    const crossSite = await request.post(`/api/front-desk/${token}/bookings`, { headers: { origin: "https://evil.example" }, data: { slotId: slots.slots[0]!.id, requesterKind: "person", disclosureAck: true, customerName: "X", customerEmail: "x@x.test" } });
    expect(crossSite.status()).toBe(403);
    const res = await request.post(`/api/front-desk/${token}/bookings`, {
      data: { slotId: slots.slots[0]!.id, requesterKind: "ai_agent", agentName: "Helpful Assistant (e2e)", agentProvider: "Example AI", disclosureAck: true, customerName: "Dana Field", customerEmail: "dana@field.test", notes: "Leak over the kitchen", clientRef: `e2e-${Date.now()}` },
    });
    expect(res.status()).toBe(202);
    expect(await res.json()).toMatchObject({ approvalRequired: true });
    // It waits for a person, labelled as coming from an AI assistant.
    await page.goto(`${scout}/approvals`);
    const card = page.locator("section, article").filter({ hasText: "Dana Field" }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/AI assistant/).first()).toBeVisible();
    await expect(card.getByText("Level 2 · Talks to customers").first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, "7-ai-booking-approval.png"), fullPage: true });
  });
});
