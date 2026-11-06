import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { evidenceDir } from "./evidence-dir";

/**
 * Plug and play for selling: the operator creates a client workspace and
 * copies one link; the client sets a password and sees a first briefing with
 * sample opportunities. Timed end to end, with the client's clicks counted.
 */
const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, ".seed.json"), "utf8")) as { password: string };
const shots = evidenceDir("plug-and-play");

const TEN_MINUTES = 10 * 60 * 1000;
const MAX_CLICKS = 15;

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

test("invite to first briefing: under 10 minutes and under 15 clicks", async ({ browser }) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  const clientEmail = `maya+${Date.now()}@peachtree.test`;

  // 1. The operator creates the workspace and copies the link.
  const ops = await (await browser.newContext()).newPage();
  await signIn(ops, "ops@e2e.test");
  await ops.goto("/admin/clients");
  await expect(ops.getByRole("heading", { level: 1, name: "New client workspace" })).toBeVisible();
  await ops.getByLabel("Business name").fill("Peachtree Roofing");
  await ops.getByLabel("Trade").selectOption("roofing");
  await ops.getByLabel(/Service-area ZIP/).fill("30303");
  await ops.getByLabel("Client's email").fill(clientEmail);
  await ops.getByLabel("Type it again to confirm").fill(clientEmail);
  await axe(ops, "admin: new client workspace");
  await ops.getByRole("button", { name: "Create workspace and link" }).click();
  const linkBox = ops.getByLabel("Invite link");
  await expect(linkBox).toBeVisible();
  const invite = await linkBox.inputValue();
  expect(invite).toMatch(/\/accept-invite\?org=.+&token=.+/);
  await ops.screenshot({ path: path.join(shots, "1-operator-link.png"), fullPage: true });
  // Least privilege: the operator is not a member of the client's workspace.
  await ops.goto("/orgs");
  await expect(ops.getByRole("link", { name: /Peachtree Roofing/ })).toHaveCount(0);
  const tLink = Date.now();

  // 2. The client opens the link on a phone. Count every click and field they touch.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  let clicks = 0;
  const click = async (l: Locator) => {
    clicks++;
    await l.click();
  };
  const fill = async (l: Locator, v: string) => {
    clicks++; // tapping into a field counts
    await l.fill(v);
  };
  await page.goto(invite);
  await expect(page.getByRole("heading", { level: 1, name: "Peachtree Roofing" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(clientEmail);
  await axe(page, "accept invite (phone)");
  await page.screenshot({ path: path.join(shots, "2-client-set-password.png"), fullPage: true });
  await fill(page.getByLabel("Your name"), "Maya Chen");
  await fill(page.getByLabel("Create a password"), "peachtree-roofing-2026");
  await click(page.getByRole("button", { name: "Open my workspace" }));

  // Step 1 of 3: already named, ZIP pre-filled, a visible time estimate.
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await expect(page.getByText("about 5 minutes left")).toBeVisible();
  await expect(page.getByLabel("Business name")).toHaveValue("Peachtree Roofing");
  await expect(page.getByLabel(/Service-area ZIP/)).toHaveValue("30303");
  await expect(page.getByRole("radio", { name: /Roofing/ })).toBeChecked();
  await axe(page, "welcome step 1 (phone)");
  await page.screenshot({ path: path.join(shots, "3-step1-business.png"), fullPage: true });
  await click(page.getByRole("button", { name: "Continue" }));

  // Step 2 of 3: connect email or skip.
  await expect(page.getByRole("heading", { name: "Connect your email" })).toBeVisible();
  await expect(page.getByText("about 3 minutes left")).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
  await axe(page, "welcome step 2 (phone)");
  await page.screenshot({ path: path.join(shots, "4-step2-email.png"), fullPage: true });
  await click(page.getByRole("button", { name: "Skip for now" }));

  // Step 3 of 3: what to watch, smart defaults already chosen.
  await expect(page.getByRole("heading", { name: "What should Scout watch?" })).toBeVisible();
  await expect(page.getByText("about a minute left")).toBeVisible();
  await expect(page.getByRole("radio", { name: "7:00 am" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /3 sample opportunities/ })).toBeChecked();
  await expect(page.getByText(/Fulton County, GA/)).toBeVisible();
  await axe(page, "welcome step 3 (phone)");
  await page.screenshot({ path: path.join(shots, "5-step3-watch.png"), fullPage: true });
  await click(page.getByRole("button", { name: "Finish and see my briefing" }));

  // First win: the briefing leads Today, then three sample opportunities.
  await expect(page).toHaveURL(/\/orgs\/[^/]+\?welcome=1/, { timeout: 60_000 });
  const transcript = page.getByRole("list", { name: "Today with Scout" });
  const first = transcript.locator(":scope > li").first();
  await expect(first).toHaveAttribute("id", "briefing");
  await expect(first).toContainText("Here's your briefing.");
  await expect(first.getByRole("heading", { name: /Storm signals and top prospects \(\d+\)/ })).toBeVisible();
  const samples = page.getByRole("list", { name: "Sample opportunities" }).getByRole("listitem");
  await expect(samples).toHaveCount(3);
  await expect(samples.first()).toContainText("(DEMO)");
  await expect(page.getByRole("region", { name: "Setup progress" })).toHaveCount(0); // setup is done
  const elapsed = Date.now() - t0;
  const clientElapsed = Date.now() - tLink;
  await page.screenshot({ path: path.join(shots, "6-first-briefing-phone.png"), fullPage: true });
  await axe(page, "Today after setup (phone)");

  console.log(`plug-and-play: total ${Math.round(elapsed / 1000)}s (client ${Math.round(clientElapsed / 1000)}s), client clicks ${clicks}`);
  expect(elapsed).toBeLessThan(TEN_MINUTES);
  expect(clicks).toBeLessThanOrEqual(MAX_CLICKS);

  // The workspace is theirs: they're the owner and it's named.
  await page.goto("/orgs");
  await expect(page.getByRole("link", { name: /Peachtree Roofing/ })).toBeVisible();
  await expect(page.getByText("owner")).toBeVisible();
  await ctx.close();
});

test("the admin screen is invisible to everyone except the operator", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const anon = await page.goto("/admin/clients");
  expect(page.url()).toMatch(/\/sign-in/);
  expect(anon?.status()).toBeLessThan(500);
  await signIn(page, "owner@e2e.test");
  const res = await page.goto("/admin/clients");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "New client workspace" })).toHaveCount(0);
});

test("a wrong or reused link explains itself; a different signed-in account is told whose invite it is", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/accept-invite?org=00000000-0000-4000-8000-000000000000");
  await expect(page.getByText(/invitation link is incomplete/)).toBeVisible();
  await signIn(page, "owner@e2e.test");
  await page.goto("/accept-invite?org=00000000-0000-4000-8000-000000000000&token=abc&email=someone@else.test&ws=Other%20Co");
  await expect(page.getByText(/this invitation is for/)).toContainText("someone@else.test");
  await expect(page.getByRole("button", { name: /Sign out and continue as someone@else.test/ })).toBeVisible();
});

test("nothing to install: a web app manifest and icons for the home screen; help explains the rest", async ({ page, request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.status()).toBe(200);
  const manifest = (await m.json()) as { name: string; display: string; start_url: string; icons: { src: string; sizes: string; purpose?: string }[] };
  expect(manifest.name).toBe("Scout OS");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/orgs");
  for (const size of ["192x192", "512x512"]) expect(manifest.icons.some((i) => i.sizes === size)).toBe(true);
  expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  for (const i of manifest.icons) expect((await request.get(i.src)).status()).toBe(200);
  await page.goto("/help");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Put it on your phone's home screen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Optional: a desktop shortcut" })).toBeVisible();
  await axe(page, "help & install");
});
