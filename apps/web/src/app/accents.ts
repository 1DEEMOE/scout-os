const ACCENT: Record<string, string> = {
  "Home services": "home",
  "Shops": "shops",
  "Beauty & personal care": "beauty",
  "Health & wellness": "health",
  "Pets": "pets",
  "Food & hospitality": "food",
  "Retail": "retail",
  "Professional services": "professional",
  "Education & childcare": "education",
  "Events": "events",
  "Startup": "startup",
  "Other": "other",
};

/** A short key for the industry accent. Unknown groups stay on the core clay. */
export function accentForGroup(group: string): string {
  return ACCENT[group] ?? "other";
}
