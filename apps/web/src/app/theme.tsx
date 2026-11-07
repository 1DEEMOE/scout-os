"use client";
import { useEffect, useState } from "react";
import { TEXT_KEY, THEME_KEY as KEY } from "./boot";

export { RAIL_KEY } from "./boot";
export type Choice = "system" | "light" | "dark";

export function apply(choice: Choice) {
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
    const sync = () => {
      const t = document.documentElement.dataset.theme;
      setChoice(t === "light" || t === "dark" ? t : "system");
    };
    sync();
    // The command palette can change the theme too.
    window.addEventListener("scout:theme", sync);
    return () => window.removeEventListener("scout:theme", sync);
  }, []);
  const options: [Choice, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return (
    <div role="group" aria-label="Theme" className="inline-flex rounded-full border border-line bg-soft p-1 text-sm">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
            apply(value);
          }}
          className={`min-h-11 rounded-full px-4 transition-colors duration-150 ${choice === value ? "bg-surface font-medium text-ink shadow-[var(--shadow-raised)]" : "text-muted hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export type TextSize = "default" | "large" | "larger";

export function applyTextSize(size: TextSize) {
  const root = document.documentElement;
  if (size === "default") delete root.dataset.text;
  else root.dataset.text = size;
  try {
    if (size === "default") localStorage.removeItem(TEXT_KEY);
    else localStorage.setItem(TEXT_KEY, size);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  window.dispatchEvent(new Event("scout:text"));
}

/** Reading size. Stored in this browser only. Default body type is 18px. */
export function TextSizeToggle() {
  const [size, setSize] = useState<TextSize>("default");
  useEffect(() => {
    const sync = () => {
      const t = document.documentElement.dataset.text;
      setSize(t === "large" || t === "larger" ? t : "default");
    };
    sync();
    window.addEventListener("scout:text", sync);
    return () => window.removeEventListener("scout:text", sync);
  }, []);
  const options: [TextSize, string][] = [
    ["default", "18"],
    ["large", "20"],
    ["larger", "22"],
  ];
  return (
    <div role="group" aria-label="Reading size" className="inline-flex rounded-full border border-line bg-soft p-1 text-sm">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={size === value}
          onClick={() => applyTextSize(value)}
          className={`min-h-11 min-w-11 rounded-full px-3 transition-colors duration-150 ${size === value ? "bg-surface font-medium text-ink shadow-[var(--shadow-raised)]" : "text-muted hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
