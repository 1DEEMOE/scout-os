"use client";
import { useEffect, useState } from "react";
import { PALETTE_KEY, TEXT_KEY, THEME_KEY as KEY } from "./boot";

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

export type PaletteName = "kiln" | "signal" | "harbor" | "nova";

/** Candidate looks. Kiln stays the default when nothing is stored. Saved in this browser only. */
export function applyPalette(palette: PaletteName) {
  const root = document.documentElement;
  if (palette === "kiln") delete root.dataset.palette;
  else root.dataset.palette = palette;
  try {
    if (palette === "kiln") localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  window.dispatchEvent(new Event("scout:palette"));
}

export function PaletteToggle() {
  const [palette, setPalette] = useState<PaletteName>("kiln");
  useEffect(() => {
    const sync = () => {
      const p = document.documentElement.dataset.palette;
      setPalette(p === "signal" || p === "harbor" || p === "nova" ? p : "kiln");
    };
    sync();
    window.addEventListener("scout:palette", sync);
    return () => window.removeEventListener("scout:palette", sync);
  }, []);
  const options: [PaletteName, string][] = [
    ["kiln", "Kiln"],
    ["signal", "Signal"],
    ["harbor", "Harbor"],
    ["nova", "Nova"],
  ];
  return (
    <div role="group" aria-label="Color palette" className="flex flex-wrap gap-1 rounded-2xl border border-line bg-soft p-1 text-sm">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={palette === value}
          onClick={() => applyPalette(value)}
          className={`min-h-11 rounded-full px-3 transition-colors duration-150 ${palette === value ? "bg-surface font-medium text-ink shadow-[var(--shadow-raised)]" : "text-muted hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
