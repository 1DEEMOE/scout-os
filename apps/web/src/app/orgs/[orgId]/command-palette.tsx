"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { apply as applyTheme } from "../../theme";
import { Icon } from "./icons";
import { commands, filterCommands, type Command, type ShellData } from "./nav-model";

export const OPEN_PALETTE = "scout:open-palette";
export const TOGGLE_RAIL = "scout:toggle-rail";

/** Opens the palette from anywhere (sidebar button, phone search button). */
export function openPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE));
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘K" on Apple devices, "Ctrl K" elsewhere. Rendered after mount to avoid a mismatch. */
export function ShortcutHint({ className = "" }: { className?: string }) {
  const [label, setLabel] = useState("");
  useEffect(() => setLabel(isMac() ? "⌘K" : "Ctrl K"), []);
  if (!label) return null;
  return (
    <kbd aria-hidden className={`rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-xs text-muted ${className}`}>
      {label}
    </kbd>
  );
}

/**
 * Cmd/Ctrl-K: jump to any page or run any action without a crowded menu.
 * A modal dialog with a combobox and a grouped listbox (WAI-ARIA combobox
 * pattern): arrows move, Enter runs, Escape closes from anywhere in the dialog
 * and returns focus.
 */
export function CommandPalette({ data }: { data: ShellData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const id = useId();
  const all = useMemo(() => commands(data), [data]);
  const results = useMemo(() => filterCommands(all, query), [all, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE, onOpen);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    if (previous instanceof HTMLElement && previous !== inputRef.current) returnTo.current = previous;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
    document.body.style.overflow = "hidden";
    // Escape must close even when focus has not reached the input yet
    // (Search + Enter, or a click on the list). Capture so it wins over the page.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = "";
      returnTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  async function run(c: Command) {
    setOpen(false);
    if (c.href) {
      router.push(c.href);
      return;
    }
    switch (c.action) {
      case "new-chat": {
        const today = `/orgs/${data.orgId}`;
        if (window.location.pathname === today) document.getElementById("composer")?.querySelector("textarea")?.focus();
        else router.push(`${today}#composer`);
        return;
      }
      case "toggle-rail":
        window.dispatchEvent(new Event(TOGGLE_RAIL));
        return;
      case "theme-light":
      case "theme-dark":
      case "theme-system":
        applyTheme(c.action.slice(6) as "light" | "dark" | "system");
        window.dispatchEvent(new Event("scout:theme"));
        return;
      case "sign-out":
        try {
          await authClient.signOut();
        } finally {
          window.location.href = "/sign-in";
        }
    }
  }

  if (!open) return null;

  const groups: { name: string; items: { c: Command; i: number }[] }[] = [];
  results.forEach((c, i) => {
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push((g = { name: c.group, items: [] }));
    g.items.push({ c, i });
  });
  const optionId = (i: number) => `${id}-opt-${i}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" tabIndex={-1} aria-label="Close command palette" className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
      <div className="motion-pop relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-raised)]">
        <div className="flex items-center gap-3 border-b-2 border-line px-5 focus-within:border-accent">
          <Icon name="search" className="h-5 w-5 text-muted" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={results.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (results.length ? (a + 1) % results.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
              } else if (e.key === "Home") {
                e.preventDefault();
                setActive(0);
              } else if (e.key === "End") {
                e.preventDefault();
                setActive(Math.max(0, results.length - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const c = results[active];
                if (c) void run(c);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === "Tab") {
                e.preventDefault(); // focus stays in the dialog
              }
            }}
            className="min-h-14 flex-1 bg-transparent text-message text-ink placeholder:text-muted focus-visible:outline-none"
          />
          <kbd aria-hidden className="rounded-md border border-line px-1.5 py-0.5 font-sans text-xs text-muted">Esc</kbd>
        </div>
        <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Pages and actions" className="overflow-y-auto p-3">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted">Nothing matches “{query}”.</p>
          ) : (
            groups.map((g) => (
              <div key={g.name} role="group" aria-label={g.name} className="mb-2 last:mb-0">
                <div aria-hidden className="px-3 pt-2 pb-1.5 text-sm text-muted">{g.name}</div>
                {g.items.map(({ c, i }) => (
                  <div
                    key={c.id}
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => void run(c)}
                    className={`flex min-h-11 cursor-pointer items-center rounded-xl px-3 text-small ${i === active ? "bg-accent-soft text-ink" : "text-ink"}`}
                  >
                    {c.label}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <p className="border-t border-line px-5 py-3 text-sm text-muted">
          <span aria-hidden>↑ ↓</span> to move · Enter to open · Esc to close
        </p>
      </div>
    </div>
  );
}
