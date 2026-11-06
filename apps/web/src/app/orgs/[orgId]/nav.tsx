"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandMark } from "../../brand-mark";
import { SignOutButton } from "../../sign-out-button";
import { RAIL_KEY, ThemeToggle } from "../../theme";
import { CommandPalette, openPalette, ShortcutHint, TOGGLE_RAIL } from "./command-palette";
import { Icon } from "./icons";
import { isActive, moreGroups, primaryItems, type NavGroup, type NavItem, type ShellData } from "./nav-model";

export type { ShellData } from "./nav-model";

/* ------------------------------------------------------------------ state */

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false; // storage blocked: fall back to the default (closed)
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

/** A remembered open/closed state. Starts closed; `forceOpen` shows it while you're inside. */
function useRemembered(key: string, forceOpen = false): [boolean, () => void, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(readFlag(key) || forceOpen), [key, forceOpen]);
  const set = useCallback(
    (v: boolean) => {
      setOpen(v);
      writeFlag(key, v);
    },
    [key],
  );
  return [open, () => set(!open), set];
}

/** Desktop icon rail; the attribute on <html> drives the layout (set before paint by NAV_BOOT). */
function useRail(): [boolean, (v: boolean) => void] {
  const [rail, setRailState] = useState(false);
  useEffect(() => setRailState(document.documentElement.dataset.rail === "1"), []);
  const setRail = useCallback((v: boolean) => {
    if (v) document.documentElement.dataset.rail = "1";
    else delete document.documentElement.dataset.rail;
    setRailState(v);
    writeFlag(RAIL_KEY, v);
  }, []);
  useEffect(() => {
    const toggle = () => setRail(document.documentElement.dataset.rail !== "1");
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener(TOGGLE_RAIL, toggle);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(TOGGLE_RAIL, toggle);
      document.removeEventListener("keydown", onKey);
    };
  }, [setRail]);
  return [rail, setRail];
}

/* -------------------------------------------------------------- pieces */

const row = "group relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-small transition-colors duration-150";
const quiet = "text-muted hover:bg-soft hover:text-ink";
const current = "bg-accent-soft font-medium text-ink";
/** In the rail, a label becomes a tooltip: still the link's accessible name, shown on hover or focus. */
const railTip =
  "rail:pointer-events-none rail:absolute rail:left-full rail:top-1/2 rail:z-50 rail:ml-3 rail:max-w-none rail:-translate-y-1/2 rail:overflow-visible rail:rounded-lg rail:bg-ink rail:px-2.5 rail:py-1 rail:text-sm rail:font-normal rail:text-paper rail:opacity-0 rail:shadow-[var(--shadow-raised)] rail:transition-opacity rail:group-hover:opacity-100 rail:group-focus:opacity-100";

function Badge({ n }: { n: number }) {
  return (
    <span className="ml-auto inline-flex min-w-6 justify-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-semibold text-on-accent rail:absolute rail:-top-0.5 rail:right-1 rail:ml-0 rail:min-w-5 rail:px-1">
      <span aria-hidden>{n}</span>
      <span className="sr-only">, {n} waiting</span>
    </span>
  );
}

function NavLink({ base, path, item, onNavigate, railable }: { base: string; path: string; item: NavItem; onNavigate?: () => void; railable?: boolean }) {
  const active = isActive(path, base, item);
  return (
    <a
      href={base + item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`${row} ${active ? current : quiet} ${railable ? "rail:justify-center rail:px-0" : ""}`}
    >
      {item.icon && <Icon name={item.icon} className={`h-5 w-5 ${active ? "text-accent" : ""}`} />}
      <span className={`min-w-0 truncate ${railable ? railTip : ""}`}>{item.label}</span>
      {item.badge ? <Badge n={item.badge} /> : null}
    </a>
  );
}

/** A collapsible group under More: closed by default, remembered, open while you're on one of its pages. */
function Group({ group, base, path, onNavigate }: { group: NavGroup; base: string; path: string; onNavigate?: () => void }) {
  const inside = group.items.some((i) => isActive(path, base, i));
  const [open, toggle] = useRemembered(`scout-nav-group:${group.id}`, inside);
  const panel = `nav-group-${group.id}`;
  return (
    <li>
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls={panel} className={`${row} w-full ${quiet}`}>
        <Icon name={group.icon} className="h-5 w-5" />
        <span className="flex-1 text-left">{group.title}</span>
        <Icon name="chevron" className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul id={panel} className="motion-rise mt-2 ml-5 flex flex-col gap-2 border-l border-line pl-3">
          {group.items.map((i) => (
            <li key={i.href}>
              <NavLink base={base} path={path} item={i} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A small anchored panel (disclosure pattern): Escape or a click outside closes it and focus returns. */
function Popover({
  label,
  named = true,
  button,
  buttonClass,
  panelClass,
  children,
}: {
  label: string;
  /** false when the button's visible text already names it (label-in-name). */
  named?: boolean;
  button: React.ReactNode;
  buttonClass: string;
  panelClass: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = `pop-${label.replace(/\W+/g, "-").toLowerCase()}`;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    (wrap.current?.querySelector(`#${panelId} a, #${panelId} button`) as HTMLElement | null)?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, panelId]);
  return (
    <div ref={wrap} className="relative">
      <button ref={btn} type="button" aria-label={named ? label : undefined} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)} className={buttonClass}>
        {button}
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={label} className={`motion-pop absolute z-50 flex flex-col gap-1 rounded-2xl border border-line bg-surface p-2 shadow-[var(--shadow-raised)] ${panelClass}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();
const menuItem = "flex min-h-11 items-center rounded-xl px-3 text-small text-ink hover:bg-soft";

function WorkspaceLinks({ d, onNavigate }: { d: ShellData; onNavigate?: () => void }) {
  return (
    <>
      {d.orgs.map((o) => (
        <a key={o.orgId} href={`/orgs/${o.orgId}`} onClick={onNavigate} aria-current={o.orgId === d.orgId ? "page" : undefined} className={`${menuItem} justify-between gap-3 ${o.orgId === d.orgId ? "font-medium" : ""}`}>
          <span className="truncate">{o.name}</span>
          {o.orgId === d.orgId && <span className="text-sm text-muted">Current</span>}
        </a>
      ))}
      <a href="/orgs" onClick={onNavigate} className={menuItem}>All workspaces</a>
      {d.isPlatformAdmin && <a href="/admin/clients" onClick={onNavigate} className={menuItem}>Client workspaces</a>}
    </>
  );
}

function ProfileItems({ d, onNavigate }: { d: ShellData; onNavigate?: () => void }) {
  return (
    <>
      <div className="px-3 pt-2 pb-3">
        <p className="truncate font-medium">{d.user.name}</p>
        <p className="truncate text-sm text-muted">{d.user.email}</p>
      </div>
      <a href={`/orgs/${d.orgId}/settings`} onClick={onNavigate} className={menuItem}>Settings</a>
      <a href="/help" onClick={onNavigate} className={menuItem}>Help &amp; install</a>
      <div className="px-2 py-2"><ThemeToggle /></div>
      <div className="px-1 pt-1 pb-1 [&_button]:w-full [&_button]:justify-center"><SignOutButton /></div>
    </>
  );
}

/** One calm footer row: workspace switcher and profile. */
function FooterRow({ d }: { d: ShellData }) {
  return (
    <div className="flex items-center gap-2 rail:flex-col">
      <div className="min-w-0 flex-1 rail:flex-none">
        <Popover
          label="Switch workspace"
          named={false}
          buttonClass={`${row} ${quiet} w-full rail:justify-center rail:px-0`}
          panelClass="bottom-full left-0 mb-2 w-64 rail:bottom-0 rail:left-full rail:mb-0 rail:ml-3"
          button={
            <>
              <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-soft text-sm font-semibold text-ink">{initial(d.orgName)}</span>
              <span className="min-w-0 flex-1 truncate text-left text-ink rail:sr-only">{d.orgName}</span>
              <span className="sr-only">, switch workspace</span>
            </>
          }
        >
          {(close) => <WorkspaceLinks d={d} onNavigate={close} />}
        </Popover>
      </div>
      <Popover
        label="Profile"
        buttonClass="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-soft"
        panelClass="bottom-full right-0 mb-2 w-72 rail:right-auto rail:bottom-0 rail:left-full rail:mb-0 rail:ml-3"
        button={<span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-accent text-sm font-semibold text-on-accent">{initial(d.user.name || d.user.email)}</span>}
      >
        {(close) => <ProfileItems d={d} onNavigate={close} />}
      </Popover>
    </div>
  );
}

/* -------------------------------------------------------------- desktop */

function Sidebar({ d, path }: { d: ShellData; path: string }) {
  const base = `/orgs/${d.orgId}`;
  const groups = moreGroups(d);
  const insideMore = groups.some((g) => g.items.some((i) => isActive(path, base, i)));
  const [more, toggleMore, setMore] = useRemembered("scout-sidebar-more", insideMore);
  const [rail, setRail] = useRail();

  return (
    <div className="flex min-h-full flex-col gap-8 px-4 py-6 rail:items-stretch rail:px-3">
      <div className="flex items-center justify-between gap-2 px-1 rail:flex-col rail:px-0">
        <a href="/orgs" className="inline-flex min-h-11 items-center rounded-lg" aria-label="Scout OS: all workspaces"><BrandMark railable /></a>
        <button
          type="button"
          onClick={() => setRail(!rail)}
          aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
          aria-controls="sidebar"
          aria-expanded={!rail}
          className="grid h-11 w-11 place-items-center rounded-xl text-muted hover:bg-soft hover:text-ink"
        >
          <Icon name="rail" />
        </button>
      </div>

      <button type="button" onClick={openPalette} className={`${row} ${quiet} border border-line bg-surface rail:justify-center rail:px-0`}>
        <Icon name="search" />
        <span className={`flex-1 text-left ${railTip}`}>Search</span>
        <ShortcutHint className="rail:hidden" />
      </button>

      <nav aria-label="Organization" className="flex flex-col gap-8">
        <ul aria-label="Main" className="flex flex-col gap-2">
          {primaryItems(d).map((i) => (
            <li key={i.label}><NavLink base={base} path={path} item={i} railable /></li>
          ))}
        </ul>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              if (rail) {
                setRail(false);
                setMore(true);
              } else toggleMore();
            }}
            aria-expanded={rail ? false : more}
            aria-controls="sidebar-more"
            className={`${row} ${quiet} rail:justify-center rail:px-0`}
          >
            <Icon name="more" />
            <span className={`flex-1 text-left ${railTip}`}>More</span>
            <Icon name="chevron" className={`h-4 w-4 transition-transform duration-200 rail:hidden ${more ? "rotate-180" : ""}`} />
          </button>
          {more && !rail && (
            <ul id="sidebar-more" aria-label="More" className="motion-rise flex flex-col gap-2">
              {groups.map((g) => <Group key={g.id} group={g} base={base} path={path} />)}
            </ul>
          )}
        </div>
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <span className="px-3 text-sm text-muted rail:hidden">Development build</span>
        <FooterRow d={d} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- phones */

/** Phone tabs: the same five destinations as the sidebar. */
function BottomTabs({ d, path }: { d: ShellData; path: string }) {
  const base = `/orgs/${d.orgId}`;
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-1 px-2 py-1.5">
        {primaryItems(d).map((t) => {
          const active = isActive(path, base, t);
          return (
            <li key={t.label} className="flex-1">
              <a
                href={base + t.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-xs transition-colors duration-150 ${active ? "font-semibold text-accent" : "text-muted"}`}
              >
                <span className={`grid h-7 w-12 place-items-center rounded-full ${active ? "bg-accent-soft" : ""}`}>
                  <Icon name={t.icon!} className="h-5 w-5" />
                </span>
                {t.label}
                {t.badge ? (
                  <span className="absolute top-1 right-[calc(50%-1.5rem)] min-w-5 rounded-full bg-accent px-1 text-center text-xs leading-5 font-semibold text-on-accent">
                    <span aria-hidden>{t.badge}</span>
                    <span className="sr-only">, {t.badge} waiting</span>
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Phone "More": a bottom sheet with every other page, the workspace switcher and your profile. */
function MoreSheet({ d, path, onClose }: { d: ShellData; path: string; onClose: () => void }) {
  const base = `/orgs/${d.orgId}`;
  const sheet = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && sheet.current) {
        // Keep focus inside the sheet while it's open.
        const f = [...sheet.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="More">
      <button type="button" aria-label="Close More" tabIndex={-1} className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div ref={sheet} className="motion-sheet absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-[1.75rem] bg-paper px-5 pt-3 pb-10 shadow-[var(--shadow-raised)]" style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}>
        <div aria-hidden className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line" />
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold">More</h2>
          <button ref={closeRef} type="button" onClick={onClose} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4">
            <Icon name="close" className="h-4 w-4" /> Close
          </button>
        </div>
        <button type="button" onClick={() => { onClose(); openPalette(); }} className={`${row} ${quiet} mb-6 w-full border border-line bg-surface`}>
          <Icon name="search" /> <span>Search</span>
        </button>
        <nav aria-label="More pages">
          <ul className="flex flex-col gap-2">
            {moreGroups(d).map((g) => <Group key={g.id} group={g} base={base} path={path} onNavigate={onClose} />)}
          </ul>
        </nav>
        <section aria-label="Workspace" className="mt-8 flex flex-col gap-1">
          <h3 className="px-3 pb-1 text-sm font-semibold text-ink">Workspace</h3>
          <WorkspaceLinks d={d} onNavigate={onClose} />
        </section>
        <section aria-label="Profile" className="mt-8 flex flex-col gap-1">
          <h3 className="px-3 pb-1 text-sm font-semibold text-ink">You</h3>
          <ProfileItems d={d} onNavigate={onClose} />
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- shell */

/** App shell: sidebar (or icon rail) on large screens; top bar, five tabs and a More sheet on phones. */
export function Shell({ data, banners, children }: { data: ShellData; banners: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname();
  const base = `/orgs/${data.orgId}`;
  const conversation = path === base || path === `${base}/chat` || path.startsWith(`${base}/chat/`);
  const [sheet, setSheet] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setSheet(false);
    requestAnimationFrame(() => moreRef.current?.focus());
  }, []);
  useEffect(() => setSheet(false), [path]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[var(--sidebar-w)_1fr] lg:transition-[grid-template-columns] lg:duration-200">
      <a href="#main" className="sr-only z-50 rounded-full bg-accent px-5 py-3 font-medium text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Skip to content</a>
      <aside id="sidebar" className="sticky top-0 hidden h-screen overflow-y-auto border-r border-line bg-paper lg:block rail:overflow-visible">
        <Sidebar d={data} path={path} />
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur lg:hidden">
        <span className="min-w-0 truncate font-medium">{data.orgName}</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={openPalette} aria-label="Search" className="grid h-11 w-11 place-items-center rounded-full border border-line">
            <Icon name="search" />
          </button>
          <button ref={moreRef} type="button" onClick={() => setSheet(true)} aria-expanded={sheet} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4">
            <Icon name="more" /> More
          </button>
        </div>
      </header>
      {sheet && <MoreSheet d={data} path={path} onClose={close} />}

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-6 pt-8 pb-32 outline-none sm:px-10 lg:pt-12 lg:pb-16">
        {/* Banners line up with the page: the narrow conversation column, or full width elsewhere. */}
        <div className={conversation ? "mx-auto max-w-3xl" : ""}>{banners}</div>
        {children}
      </main>
      <BottomTabs d={data} path={path} />
      <CommandPalette data={data} />
    </div>
  );
}
