import type { IconName } from "./icons";

/**
 * One map of every destination in a workspace. The sidebar, the phone tabs,
 * the More sheet and the command palette all read from it, so nothing is
 * reachable in one place and missing in another, and pages a role can't open
 * are never offered.
 */
export interface ShellData {
  orgId: string;
  orgName: string;
  role: string;
  isManager: boolean;
  isViewer: boolean;
  hasScout: boolean;
  waiting: number;
  teammates: { id: string; name: string; active: boolean }[];
  routines: { id: string; name: string; kind: string }[];
  threads: { id: string; title: string }[];
  orgs: { orgId: string; name: string; role: string }[];
  user: { name: string; email: string };
  isPlatformAdmin: boolean;
}

export interface NavItem {
  href: string; // relative to /orgs/<id>
  label: string;
  icon?: IconName;
  badge?: number;
  exact?: boolean;
  also?: string[];
  /** Extra words the command palette matches on. */
  keywords?: string;
}

export interface NavGroup {
  id: string;
  title: string;
  icon: IconName;
  items: NavItem[];
}

export function isActive(path: string, base: string, l: NavItem): boolean {
  if (l.exact) return path === base + l.href || (l.also ?? []).some((h) => path === base + h || path.startsWith(base + h + "/"));
  const href = l.href.split("#")[0]!;
  return [href, ...(l.also ?? [])].some((h) => path === base + h || path.startsWith(base + h + "/"));
}

/** The five calm primary destinations, in order. */
export function primaryItems(d: ShellData): NavItem[] {
  const scout = d.hasScout && !d.isViewer;
  return [
    { href: "", label: "Today", icon: "today", exact: true, also: ["/chat"], keywords: "home chat briefing" },
    { href: "/approvals", label: "Approvals", icon: "approvals", badge: d.waiting, keywords: "inbox needs your ok decide" },
    { href: "/tasks", label: "Work", icon: "work", keywords: "jobs tasks" },
    { href: "/sales", label: "Customers", icon: "customers", keywords: "deals contacts crm" },
    scout
      ? { href: "/scout", label: "Scout", icon: "scout", keywords: "leads opportunities prospects" }
      : { href: "/inbox", label: "Leads", icon: "leads", keywords: "inbox email" },
  ];
}

/** Everything else, in collapsible groups behind "More". */
export function moreGroups(d: ShellData): NavGroup[] {
  const scout = d.hasScout && !d.isViewer;
  const routines: NavItem[] = [
    ...d.routines.map((r) => ({ href: r.kind === "morning_briefing" ? "/routines/briefing" : `/routines/${r.id}`, label: r.name, keywords: "routine" })),
    { href: "/routines", label: d.routines.length ? "All routines" : "Set up a routine", exact: true, keywords: "schedule automation briefing" },
  ];
  return [
    {
      id: "teammates",
      title: "Teammates & routines",
      icon: "teammates",
      items: [{ href: "/agents", label: d.teammates.length ? "AI teammates" : "Add your AI teammates", keywords: "agents workforce" }, ...routines],
    },
    {
      id: "library",
      title: "Library",
      icon: "library",
      items: [
        { href: "/chat", label: "Conversations", keywords: "threads history chats" },
        ...(scout ? [{ href: "/inbox", label: "Inbox", keywords: "email messages" }] : []),
        { href: "/finance", label: "Invoices", keywords: "billing money overdue finance payments" },
        ...(scout
          ? [
              { href: "/analytics", label: "Analytics", keywords: "reports numbers" },
              { href: "/scout/signals", label: "Storm reports", keywords: "hail wind tornado signals" },
            ]
          : []),
      ],
    },
    {
      id: "workspace",
      title: "Workspace",
      icon: "workspace",
      items: [
        { href: "/settings", label: "Settings", exact: true, keywords: "preferences pause agents" },
        { href: "/settings#team", label: "Team", keywords: "members invite people roles" },
        { href: "/settings#connections", label: "Integrations", keywords: "connect gmail google hubspot stripe apps" },
        { href: "/settings/front-desk", label: "Front desk", keywords: "booking link appointments" },
        ...(scout
          ? [
              { href: "/scout/setup", label: "Scout setup", keywords: "service area trade" },
              { href: "/scout/contacts", label: "Contact rules", keywords: "do not contact compliance" },
            ]
          : []),
        { href: "/billing", label: "Plan & billing", keywords: "usage subscription payment" },
        ...(d.isManager ? [{ href: "/audit", label: "Audit log", keywords: "history security" }] : []),
        { href: "/setup", label: "Guided setup", keywords: "onboarding checklist getting started" },
      ],
    },
  ];
}

export interface Command {
  id: string;
  label: string;
  group: "Go to" | "Actions" | "Workspaces" | "Recent conversations";
  href?: string;
  action?: "new-chat" | "toggle-rail" | "theme-light" | "theme-dark" | "theme-system" | "sign-out";
  keywords?: string;
}

/** Every page and action, for the Cmd/Ctrl-K palette. */
export function commands(d: ShellData): Command[] {
  const base = `/orgs/${d.orgId}`;
  const seen = new Set<string>();
  const pages: Command[] = [];
  for (const it of [...primaryItems(d), ...moreGroups(d).flatMap((g) => g.items)]) {
    if (seen.has(it.href)) continue;
    seen.add(it.href);
    pages.push({ id: `go:${it.href}`, label: it.label, group: "Go to", href: base + it.href, keywords: it.keywords });
  }
  pages.push({ id: "go:/help", label: "Help & install", group: "Go to", href: "/help", keywords: "home screen desktop shortcut app support" });
  if (d.isPlatformAdmin) pages.push({ id: "go:/admin/clients", label: "Client workspaces (admin)", group: "Go to", href: "/admin/clients", keywords: "new client invite create workspace" });
  const actions: Command[] = [
    ...(d.isViewer ? [] : [{ id: "act:new-chat", label: "New chat with Scout", group: "Actions" as const, action: "new-chat" as const, keywords: "ask message compose" }]),
    { id: "act:rail", label: "Collapse or expand the sidebar", group: "Actions", action: "toggle-rail", keywords: "rail icons narrow wide" },
    { id: "act:light", label: "Use light theme", group: "Actions", action: "theme-light", keywords: "appearance" },
    { id: "act:dark", label: "Use dark theme", group: "Actions", action: "theme-dark", keywords: "appearance night" },
    { id: "act:system", label: "Match system theme", group: "Actions", action: "theme-system", keywords: "appearance auto" },
    { id: "act:sign-out", label: "Sign out", group: "Actions", action: "sign-out", keywords: "log out leave" },
  ];
  const orgs: Command[] = d.orgs
    .filter((o) => o.orgId !== d.orgId)
    .map((o) => ({ id: `org:${o.orgId}`, label: `Switch to ${o.name}`, group: "Workspaces", href: `/orgs/${o.orgId}`, keywords: "workspace organization" }));
  orgs.push({ id: "org:all", label: "All workspaces", group: "Workspaces", href: "/orgs", keywords: "switch organization create" });
  const threads: Command[] = d.threads.map((t) => ({ id: `thread:${t.id}`, label: t.title, group: "Recent conversations", href: `${base}/chat/${t.id}`, keywords: "chat" }));
  return [...pages, ...actions, ...threads, ...orgs];
}

/** Case-insensitive match on every word of the query, against label and keywords. Best matches first. */
export function filterCommands(all: Command[], query: string): Command[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  const scored = all
    .map((c) => {
      const label = c.label.toLowerCase();
      const hay = `${label} ${c.keywords ?? ""} ${c.group}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const score = label.startsWith(words[0]!) ? 0 : label.includes(words[0]!) ? 1 : 2;
      return { c, score };
    })
    .filter((x): x is { c: Command; score: number } => x !== null);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.c);
}
