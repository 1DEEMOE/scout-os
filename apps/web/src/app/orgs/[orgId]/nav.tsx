"use client";
import { usePathname } from "next/navigation";

type Child = { href: string; label: string };
type Item =
  | { kind: "link"; href: string; label: string; match?: (path: string, base: string) => boolean }
  | { kind: "group"; label: string; href: string; children: Child[]; matchPrefix: string[] };

function linkActive(path: string, target: string, exact: boolean) {
  return exact ? path === target : path === target || path.startsWith(target + "/");
}

/** Primary destinations for the phone bottom bar — roomy, not cramped. */
function mobilePrimary(
  base: string,
  hasScout: boolean,
  isViewer: boolean,
): Array<{ href: string; label: string; match: (path: string) => boolean }> {
  const leadsHref = hasScout && !isViewer ? "/scout" : "/inbox";
  return [
    { href: "", label: "Today", match: (p) => p === base },
    {
      href: "/approvals",
      label: "Approvals",
      match: (p) => p === base + "/approvals" || p.startsWith(base + "/approvals/"),
    },
    {
      href: leadsHref,
      label: "Leads",
      match: (p) =>
        p === base + leadsHref ||
        p.startsWith(base + leadsHref + "/") ||
        (leadsHref === "/scout" && (p.startsWith(base + "/scout") || p.startsWith(base + "/analytics"))),
    },
    {
      href: "/tasks",
      label: "Jobs",
      match: (p) => p === base + "/tasks" || p.startsWith(base + "/tasks/") || p.startsWith(base + "/sales"),
    },
    {
      href: "/routines/briefing",
      label: "Briefing",
      match: (p) => p.startsWith(base + "/routines"),
    },
  ];
}

export function Nav({
  orgId,
  isManager,
  isViewer,
  hasScout,
}: {
  orgId: string;
  isManager: boolean;
  isViewer: boolean;
  hasScout: boolean;
}) {
  const path = usePathname();
  const base = `/orgs/${orgId}`;
  const mobile = mobilePrimary(base, hasScout, isViewer);

  const items: Item[] = [
    {
      kind: "link",
      href: "",
      label: "Today",
      match: (p, b) => p === b,
    },
    {
      kind: "group",
      label: "Leads",
      href: hasScout && !isViewer ? "/scout" : "/inbox",
      matchPrefix: hasScout && !isViewer ? ["/scout", "/analytics"] : ["/inbox"],
      children: [
        ...(hasScout && !isViewer
          ? [
              { href: "/scout", label: "Lead feed" },
              { href: "/scout/signals", label: "Storm reports" },
              { href: "/scout/contacts", label: "Contact rules" },
              { href: "/scout/setup", label: "Scout setup" },
              { href: "/analytics", label: "Analytics" },
            ]
          : []),
        { href: "/inbox", label: "Inbox" },
        { href: "/chat", label: "Chat" },
      ],
    },
    {
      kind: "group",
      label: "Customers & Deals",
      href: "/sales",
      matchPrefix: ["/sales", "/tasks"],
      children: [
        { href: "/sales", label: "Pipeline" },
        { href: "/tasks", label: "Tasks" },
        { href: "/routines", label: "Routines" },
        { href: "/routines/briefing", label: "Morning briefing" },
        { href: "/agents", label: "AI workforce" },
      ],
    },
    {
      kind: "group",
      label: "Money",
      href: "/finance",
      matchPrefix: ["/finance", "/approvals", "/billing"],
      children: [
        { href: "/approvals", label: "Needs your OK" },
        { href: "/finance", label: "Invoices" },
        { href: "/billing", label: "Plan & usage" },
      ],
    },
    {
      kind: "group",
      label: "Settings",
      href: "/settings",
      matchPrefix: ["/settings", "/audit", "/setup"],
      children: [
        { href: "/settings", label: "Team & connections" },
        ...(isManager ? [{ href: "/audit", label: "Audit log" }] : []),
        { href: "/setup", label: "Guided setup" },
      ],
    },
  ];

  return (
    <>
      {/* Desktop / tablet top nav — hidden on phone */}
      <nav aria-label="Organization" className="hidden border-b border-line sm:block">
        <ul className="flex flex-wrap gap-1 pb-px">
          {items.map((item) => {
            if (item.kind === "link") {
              const target = base + item.href;
              const active = item.match ? item.match(path, base) : linkActive(path, target, item.href === "");
              return (
                <li key={item.label}>
                  <a
                    href={target}
                    aria-current={active ? "page" : undefined}
                    className={`inline-block whitespace-nowrap rounded-t-lg px-4 py-3 text-base ${
                      active ? "border-b-2 border-accent font-semibold text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </a>
                </li>
              );
            }
            const groupActive = item.matchPrefix.some((p) => path === base + p || path.startsWith(base + p + "/"));
            return (
              <li key={item.label} className="relative">
                <details className="group/nav">
                  <summary
                    className={`flex cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-t-lg px-4 py-3 text-base marker:content-none [&::-webkit-details-marker]:hidden ${
                      groupActive ? "border-b-2 border-accent font-semibold text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    <a href={base + item.href} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                      {item.label}
                    </a>
                    <span aria-hidden className="text-sm opacity-60">
                      ▾
                    </span>
                  </summary>
                  <ul className="absolute left-0 z-20 mt-1 min-w-[12rem] rounded-xl border border-line bg-surface p-2 shadow-lg">
                    {item.children.map((c) => {
                      const target = base + c.href;
                      const isActive =
                        c.href === "/scout"
                          ? path === base + "/scout" || path.startsWith(base + "/scout/opportunities")
                          : path === target || path.startsWith(target + "/");
                      return (
                        <li key={c.href}>
                          <a
                            href={target}
                            aria-current={isActive ? "page" : undefined}
                            className={`block rounded-lg px-3 py-2.5 text-base ${isActive ? "bg-accent/10 font-medium text-ink" : "text-muted hover:bg-line/40 hover:text-ink"}`}
                          >
                            {c.label}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Phone: roomy bottom bar for the five key flows */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-1 px-2 py-2">
          {mobile.map((item) => {
            const target = base + item.href;
            const active = item.match(path);
            return (
              <li key={item.label} className="flex-1">
                <a
                  href={target}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-[3.25rem] flex-col items-center justify-center rounded-xl px-1 py-2 text-sm ${
                    active ? "bg-accent/10 font-semibold text-ink" : "text-muted"
                  }`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
