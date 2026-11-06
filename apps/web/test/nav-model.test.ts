import { describe, expect, it } from "vitest";
import { commands, filterCommands, isActive, moreGroups, primaryItems, type ShellData } from "../src/app/orgs/[orgId]/nav-model";
import { isPlatformAdmin } from "../src/server/platform-admin";

const d = (over: Partial<ShellData> = {}): ShellData => ({
  orgId: "o1",
  orgName: "Peachtree Roofing",
  role: "owner",
  isManager: true,
  isViewer: false,
  hasScout: true,
  waiting: 3,
  teammates: [],
  routines: [{ id: "r1", name: "Morning briefing", kind: "morning_briefing" }],
  threads: [{ id: "t1", title: "Chase overdue invoices" }],
  orgs: [{ orgId: "o1", name: "Peachtree Roofing", role: "owner" }, { orgId: "o2", name: "Second Co", role: "member" }],
  user: { name: "Olivia", email: "o@x.test" },
  isPlatformAdmin: false,
  ...over,
});

describe("navigation model", () => {
  it("has exactly five calm primary items, each with an icon", () => {
    const p = primaryItems(d());
    expect(p.map((i) => i.label)).toEqual(["Today", "Approvals", "Work", "Customers", "Scout"]);
    expect(p.every((i) => i.icon)).toBe(true);
    expect(p[1]!.badge).toBe(3);
  });
  it("orgs without Scout (and viewers) get Leads, never a Scout link", () => {
    expect(primaryItems(d({ hasScout: false }))[4]!.label).toBe("Leads");
    expect(primaryItems(d({ isViewer: true, role: "viewer" }))[4]!.label).toBe("Leads");
  });
  it("puts routines, library, billing, integrations, team and settings behind More", () => {
    const labels = moreGroups(d()).flatMap((g) => g.items.map((i) => i.label));
    for (const l of ["Morning briefing", "Invoices", "Plan & billing", "Integrations", "Team", "Settings", "Audit log"]) expect(labels).toContain(l);
  });
  it("never offers a page the role can't open", () => {
    const viewer = d({ isViewer: true, role: "viewer", isManager: false });
    const everything = [...primaryItems(viewer), ...moreGroups(viewer).flatMap((g) => g.items)].map((i) => i.label);
    for (const l of ["Scout", "Analytics", "Audit log", "Storm reports", "Scout setup"]) expect(everything).not.toContain(l);
    const labels = commands(viewer).map((c) => c.label);
    expect(labels).not.toContain("Audit log");
    expect(labels).not.toContain("New chat with Scout");
    expect(labels).not.toContain("Client workspaces (admin)");
  });
  it("the palette reaches every sidebar destination, once", () => {
    const s = d();
    const hrefs = commands(s).filter((c) => c.group === "Go to").map((c) => c.href);
    for (const i of [...primaryItems(s), ...moreGroups(s).flatMap((g) => g.items)]) expect(hrefs).toContain(`/orgs/o1${i.href}`);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(commands(s).map((c) => c.label)).toContain("Switch to Second Co");
  });
  it("palette search: every word must match; label prefixes rank first", () => {
    const all = commands(d());
    expect(filterCommands(all, "invo")[0]!.label).toBe("Invoices");
    expect(filterCommands(all, "dark theme").map((c) => c.label)).toEqual(["Use dark theme"]);
    expect(filterCommands(all, "gmail")[0]!.label).toBe("Integrations"); // matched on keywords
    expect(filterCommands(all, "qqqq")).toEqual([]);
    expect(filterCommands(all, "  ")).toHaveLength(all.length);
  });
  it("active state: Today covers chat threads; anchors match their page", () => {
    const base = "/orgs/o1";
    const [today] = primaryItems(d());
    expect(isActive("/orgs/o1", base, today!)).toBe(true);
    expect(isActive("/orgs/o1/chat/t1", base, today!)).toBe(true);
    expect(isActive("/orgs/o1/tasks", base, today!)).toBe(false);
    expect(isActive("/orgs/o1/settings", base, { href: "/settings#team", label: "Team" })).toBe(true);
  });
});

describe("platform admin", () => {
  const user = { id: "u-123", email: "darian@x.test", emailVerified: true };
  it("is nobody by default", () => {
    delete process.env.WOS_PLATFORM_ADMIN_USER_IDS;
    delete process.env.WOS_PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdmin(user)).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });
  it("honours user ids, and emails only once verified", () => {
    process.env.WOS_PLATFORM_ADMIN_EMAILS = "Darian@x.test";
    expect(isPlatformAdmin(user)).toBe(true);
    expect(isPlatformAdmin({ ...user, emailVerified: false })).toBe(false);
    delete process.env.WOS_PLATFORM_ADMIN_EMAILS;
    process.env.WOS_PLATFORM_ADMIN_USER_IDS = "other, u-123";
    expect(isPlatformAdmin({ ...user, emailVerified: false })).toBe(true);
    delete process.env.WOS_PLATFORM_ADMIN_USER_IDS;
  });
});
