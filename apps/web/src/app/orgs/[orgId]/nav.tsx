"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandMark } from "../../brand-mark";
import { SignOutButton } from "../../sign-out-button";
import { ThemeToggle } from "../../theme";

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
}

type Link = { href: string; label: string; badge?: number; exact?: boolean; also?: string[] };

function isActive(path: string, base: string, l: Link) {
  const t = base + l.href;
  if (l.exact) return path === t;
  return [l.href, ...(l.also ?? [])].some((h) => path === base + h || path.startsWith(base + h + "/"));
}

function NavLink({ base, path, link, onNavigate }: { base: string; path: string; link: Link; onNavigate?: () => void }) {
  const active = isActive(path, base, link);
  return (
    <a
      href={base + link.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 py-2 text-small transition-colors duration-150 ${
        active ? "bg-surface font-medium text-ink shadow-[var(--shadow-raised)]" : "text-muted hover:bg-soft hover:text-ink"
      }`}
    >
      <span className="min-w-0 truncate">{link.label}</span>
      {link.badge ? (
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">
          <span aria-hidden>{link.badge}</span>
          <span className="sr-only">, {link.badge} waiting</span>
        </span>
      ) : null}
    </a>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="px-3 pb-1 text-sm text-muted">{title}</h3>
      {children}
    </div>
  );
}

const MORE_KEY = "scout-sidebar-more";

/**
 * The sidebar: five calm primary destinations, then everything else behind
 * "More" (remembered per browser, and open whenever you're on one of its pages).
 */
function Sidebar({ d, path, onNavigate }: { d: ShellData; path: string; onNavigate?: () => void }) {
  const base = `/orgs/${d.orgId}`;
  const scout = d.hasScout && !d.isViewer;
  const primary: Link[] = [
    { href: "", label: "Today", exact: true },
    { href: "/approvals", label: "Needs your OK", badge: d.waiting },
    { href: "/chat", label: "Conversations" },
    scout ? { href: "/scout", label: "Leads", also: ["/scout/opportunities"] } : { href: "/inbox", label: "Leads" },
    { href: "/tasks", label: "Jobs" },
  ];
  const library: Link[] = [
    ...(scout ? [{ href: "/inbox", label: "Inbox" } as Link] : []),
    { href: "/sales", label: "Customers & deals" },
    { href: "/finance", label: "Invoices" },
    ...(scout ? [{ href: "/analytics", label: "Analytics" } as Link] : []),
  ];
  const workspace: Link[] = [
    { href: "/settings/front-desk", label: "Front desk" },
    ...(scout ? [{ href: "/scout/setup", label: "Scout setup" } as Link, { href: "/scout/signals", label: "Storm reports" } as Link, { href: "/scout/contacts", label: "Contact rules" } as Link] : []),
    { href: "/billing", label: "Plan & usage" },
    ...(d.isManager ? [{ href: "/audit", label: "Audit log" } as Link] : []),
    { href: "/setup", label: "Guided setup" },
  ];
  const routines: Link[] = [
    ...d.routines.map((r) => ({ href: r.kind === "morning_briefing" ? "/routines/briefing" : `/routines/${r.id}`, label: r.name })),
    { href: "/routines", label: d.routines.length ? "All routines" : "Set up a routine", exact: true },
  ];
  const insideMore = [...library, ...workspace, ...routines, { href: "/agents", label: "" }].some((l) => isActive(path, base, l));
  const [more, setMore] = useState(false);
  useEffect(() => {
    let saved = false;
    try {
      saved = localStorage.getItem(MORE_KEY) === "1";
    } catch {
      // Storage blocked: start closed.
    }
    setMore(saved || insideMore);
  }, [insideMore]);
  const toggle = () => {
    const next = !more;
    setMore(next);
    try {
      localStorage.setItem(MORE_KEY, next ? "1" : "0");
    } catch {
      // Not remembered this time.
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-8 px-4 py-6">
      <div className="flex flex-col gap-5 px-1">
        <a href="/orgs" className="inline-flex min-h-11 items-center self-start rounded-lg" aria-label="Scout OS: all organizations"><BrandMark /></a>
        <a href="/orgs" className="flex min-h-14 flex-col justify-center rounded-2xl border border-line bg-surface px-4 py-2.5 transition-colors duration-150 hover:bg-soft">
          <span className="truncate font-medium">{d.orgName}</span>
          <span className="text-sm text-muted">Switch organization</span>
        </a>
        {!d.isViewer && (
          <a href={`${base}#composer`} onClick={onNavigate} className="inline-flex min-h-12 items-center justify-center rounded-full bg-accent px-5 font-medium text-on-accent transition-[filter] duration-150 hover:brightness-110">
            New chat
          </a>
        )}
      </div>

      <nav aria-label="Organization" className="flex flex-col gap-8">
        <ul className="flex flex-col gap-1">
          {primary.map((l) => (
            <li key={l.label}><NavLink base={base} path={path} onNavigate={onNavigate} link={l} /></li>
          ))}
        </ul>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={more}
            aria-controls="sidebar-more"
            className="flex min-h-11 items-center justify-between rounded-xl px-3 text-small text-muted transition-colors duration-150 hover:bg-soft hover:text-ink"
          >
            More
            <svg aria-hidden viewBox="0 0 20 20" className={`h-4 w-4 transition-transform duration-200 ${more ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 8 5 5 5-5" />
            </svg>
          </button>
          {more && (
            <div id="sidebar-more" className="motion-rise flex flex-col gap-7">
              <Group title="Teammates">
                {d.teammates.length === 0 ? (
                  <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "/agents", label: "Add your AI workforce" }} />
                ) : (
                  <>
                    {d.teammates.slice(0, 4).map((a) => (
                      <a key={a.id} href={`${base}/agents`} onClick={onNavigate} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-small text-muted transition-colors duration-150 hover:bg-soft hover:text-ink">
                        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${a.active ? "bg-accent" : "bg-line"}`} />
                        <span className="truncate">{a.name}</span>
                        <span className="sr-only"> ({a.active ? "active" : "paused"})</span>
                      </a>
                    ))}
                  </>
                )}
              </Group>
              <Group title="Routines">
                {routines.map((l) => (
                  <NavLink key={l.href} base={base} path={path} onNavigate={onNavigate} link={l} />
                ))}
              </Group>
              <Group title="Library">
                {library.map((l) => (
                  <NavLink key={l.href} base={base} path={path} onNavigate={onNavigate} link={l} />
                ))}
              </Group>
              <Group title="Workspace">
                {workspace.map((l) => (
                  <NavLink key={l.href} base={base} path={path} onNavigate={onNavigate} link={l} />
                ))}
              </Group>
            </div>
          )}
        </div>
      </nav>

      <div className="mt-auto flex flex-col gap-4 border-t border-line px-1 pt-6">
        <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "/settings", label: "Settings", exact: true }} />
        <ThemeToggle />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SignOutButton />
          <span className="text-sm text-muted">Development build</span>
        </div>
      </div>
    </div>
  );
}

/** Phone tabs: the same five destinations as before, roomy. */
function BottomTabs({ d, path }: { d: ShellData; path: string }) {
  const base = `/orgs/${d.orgId}`;
  const leads = d.hasScout && !d.isViewer ? "/scout" : "/inbox";
  const tabs: Link[] = [
    { href: "", label: "Today", exact: true },
    { href: "/approvals", label: "Approvals", badge: d.waiting },
    { href: leads, label: "Leads", also: leads === "/scout" ? ["/analytics"] : [] },
    { href: "/tasks", label: "Jobs", also: ["/sales"] },
    { href: "/routines/briefing", label: "Briefing", also: ["/routines"] },
  ];
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-1 px-2 py-2">
        {tabs.map((t) => {
          const active = isActive(path, base, t);
          return (
            <li key={t.label} className="flex-1">
              <a
                href={base + t.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-[3.25rem] flex-col items-center justify-center rounded-2xl px-1 py-2 text-sm transition-colors duration-150 ${active ? "bg-accent-soft font-semibold text-accent" : "text-muted"}`}
              >
                {t.label}
                {t.badge ? (
                  <>
                    <span aria-hidden className="absolute top-1.5 right-3 h-2 w-2 rounded-full bg-accent" />
                    <span className="sr-only">, {t.badge} waiting</span>
                  </>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** App shell: sidebar on large screens; top bar, drawer and bottom tabs on phones and tablets. */
export function Shell({ data, banners, children }: { data: ShellData; banners: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname();
  const base = `/orgs/${data.orgId}`;
  const conversation = path === base || path === `${base}/chat` || path.startsWith(`${base}/chat/`);
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      menuRef.current?.focus();
    };
  }, [open]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[17.5rem_1fr]">
      <aside className="sticky top-0 hidden h-screen overflow-y-auto border-r border-line bg-paper lg:block">
        <Sidebar d={data} path={path} />
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
        <button
          ref={menuRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="org-drawer"
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-base"
        >
          <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 6h14M3 10h14M3 14h9" />
          </svg>
          Menu
        </button>
        <span className="min-w-0 truncate font-medium">{data.orgName}</span>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" id="org-drawer" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" tabIndex={-1} className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <div className="motion-drawer relative h-full w-[min(20rem,88vw)] overflow-y-auto bg-paper shadow-[var(--shadow-raised)]">
            <div className="flex justify-end px-4 pt-4">
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 items-center rounded-full border border-line px-4">
                Close
              </button>
            </div>
            <Sidebar d={data} path={path} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-5xl px-6 pt-8 pb-32 sm:px-10 lg:pt-12 lg:pb-16">
        {/* Banners line up with the page: the narrow conversation column, or full width elsewhere. */}
        <div className={conversation ? "mx-auto max-w-3xl" : ""}>{banners}</div>
        {children}
      </main>
      <BottomTabs d={data} path={path} />
    </div>
  );
}
