"use client";
import { useEffect, useState } from "react";

type Choice = "system" | "light" | "dark";
const KEY = "scout-theme";

/** Runs before first paint (inlined in <head>) so the page never flashes the wrong theme. */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

function apply(choice: Choice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
}

/** System / Light / Dark. A per-browser convenience; nothing is stored on the server. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") setChoice(t);
  }, []);
  const options: [Choice, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return (
    <div role="group" aria-label="Theme" className="inline-flex rounded-full border border-line bg-soft p-0.5 text-sm">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
            apply(value);
          }}
          className={`min-h-9 rounded-full px-3 transition-colors duration-150 ${choice === value ? "bg-surface font-medium text-ink shadow-[var(--shadow-raised)]" : "text-muted hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
