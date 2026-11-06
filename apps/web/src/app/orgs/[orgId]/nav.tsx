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
      className={`flex min-h-10 items-center justify-between gap-2 rounded-xl px-3 py-2 text-[0.95rem] transition-colors duration-150 ${
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="px-3 pb-1 text-sm font-medium text-muted">{title}</h2>
      {children}
    </div>
  );
}

/** The quiet sidebar: conversation first, then teammates, routines and the library. */
function Sidebar({ d, path, onNavigate }: { d: ShellData; path: string; onNavigate?: () => void }) {
  const base = `/orgs/${d.orgId}`;
  const scout = d.hasScout && !d.isViewer;
  const library: Link[] = [
    ...(scout ? [{ href: "/scout", label: "Lead feed", also: ["/scout/opportunities"] } as Link] : []),
    { href: "/inbox", label: "Inbox" },
    { href: "/sales", label: "Customers & deals" },
    { href: "/tasks", label: "Jobs" },
    { href: "/finance", label: "Invoices" },
    ...(scout ? [{ href: "/analytics", label: "Analytics" } as Link] : []),
  ];
  const workspace: Link[] = [
    { href: "/settings", label: "Team & connections", exact: true },
    { href: "/settings/front-desk", label: "Front desk" },
    ...(scout ? [{ href: "/scout/setup", label: "Scout setup" } as Link, { href: "/scout/signals", label: "Storm reports" } as Link, { href: "/scout/contacts", label: "Contact rules" } as Link] : []),
    { href: "/billing", label: "Plan & usage" },
    ...(d.isManager ? [{ href: "/audit", label: "Audit log" } as Link] : []),
    { href: "/setup", label: "Guided setup" },
  ];
  return (
    <div className="flex h-full flex-col gap-7 px-3 py-5">
      <div className="flex flex-col gap-4 px-2">
        <a href="/orgs" className="self-start rounded-lg" aria-label="Scout OS: all organizations"><BrandMark /></a>
        <a href="/orgs" className="flex flex-col rounded-xl border border-line bg-surface px-3 py-2 hover:bg-soft">
          <span className="truncate font-medium">{d.orgName}</span>
          <span className="text-sm text-muted">{d.role} · switch</span>
        </a>
        {!d.isViewer && (
          <a href={`${base}#composer`} onClick={onNavigate} className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-4 font-medium text-on-accent hover:brightness-110">
            New chat
          </a>
        )}
      </div>

      <nav aria-label="Organization" className="flex flex-col gap-7">
        <div className="flex flex-col gap-0.5">
          <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "", label: "Today", exact: true }} />
          <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "/approvals", label: "Needs your OK", badge: d.waiting }} />
          <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "/chat", label: "Conversations", exact: true }} />
          {d.threads.map((t) => (
            <NavLink key={t.id} base={base} path={path} onNavigate={onNavigate} link={{ href: `/chat/${t.id}`, label: t.title }} />
          ))}
        </div>

        <Section title="Teammates">
          {d.teammates.length === 0 ? (
            <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "/agents", label: "Add your AI workforce" }} />
          ) : (
            d.teammates.map((a) => (
              <a key={a.id} href={`${base}/agents`} onClick={onNavigate} className="flex min-h-10 items-center gap-2.5 rounded-xl px-3 py-2 text-[0.95rem] text-muted hover:bg-soft hover:text-ink">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${a.active ? "bg-accent" : "bg-line"}`} />
                <span className="truncate">{a.name}</span>
                <span className="sr-only"> ({a.active ? "active" : "paused"})</span>
              </a>
            ))
          )}
        </Section>

        <Section title="Routines">
          {d.routines.map((r) => (
            <NavLink key={r.id} base={base} path={path} onNavigate={onNavigate} link={{ href: r.kind === "morning_briefing" ? "/routines/briefing" : `/routines/${r.id}`, label: r.name }} />
          ))}
          <NavLink base={base} path={path} onNavigate={onNavigate} link={{ href: "/routines", label: d.routines.length ? "All routines" : "Set up a routine", exact: true }} />
        </Section>

        <Section title="Library">
          {library.map((l) => (
            <NavLink key={l.href} base={base} path={path} onNavigate={onNavigate} link={l} />
          ))}
        </Section>

        <Section title="Workspace">
          {workspace.map((l) => (
            <NavLink key={l.href} base={base} path={path} onNavigate={onNavigate} link={l} />
          ))}
        </Section>
      </nav>

      <div className="mt-auto flex flex-col gap-3 border-t border-line px-2 pt-5">
        <ThemeToggle />
        <div className="flex flex-wrap items-center justify-between gap-2">
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
