"use client";
import { useEffect } from "react";

/** Sets the industry accent on <html>. Removed when leaving the workspace. */
export function PackAccent({ accent }: { accent: string }) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = accent;
    return () => {
      delete root.dataset.accent;
    };
  }, [accent]);
  return null;
}
