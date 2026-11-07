import { z } from "zod";

/** The shape every industry pack file must satisfy. PACK_VERSION lives with the data. */
export const packSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(2).max(60),
  group: z.enum([
    "Home services",
    "Shops",
    "Beauty & personal care",
    "Health & wellness",
    "Pets",
    "Food & hospitality",
    "Retail",
    "Professional services",
    "Education & childcare",
    "Events",
    "Startup",
    "Other",
  ]),
  summary: z.string().min(8).max(240),
  flow: z.enum(["job", "appointment"]),
  legacyColumn: z.enum(["roofing", "general"]),
  trialPlan: z.enum(["scout_pro", "growth"]),
  vocabulary: z.object({ work: z.string().min(2), customer: z.string().min(2) }),
  leadFields: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(3),
  services: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    durationMinutes: z.number().int().positive().optional(),
    priceCents: z.number().int().positive(),
    priceIsExample: z.literal(true),
  })).min(1),
  templates: z.array(z.object({
    purpose: z.enum(["first_response", "rebook", "no_show", "late_cancel", "review"]),
    channel: z.enum(["email", "sms"]),
    name: z.string().min(1),
    body: z.string().min(8).max(500),
  })).min(1),
  pipeline: z.array(z.string().min(2)).min(3),
  brief: z.array(z.string().min(2)).min(3),
  routines: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(2),
    tier: z.union([z.literal(0), z.literal(1)]),
    does: z.string().min(8),
  })).min(2),
  /** Suggested connections only. Nothing is connected or billed from the pack. */
  integrations: z.array(z.object({
    kind: z.enum(["calendar", "crm", "accounting"]),
    label: z.string().min(2).max(40),
    note: z.string().min(8).max(180),
  })).min(1),
  /** Lines the morning briefing can count. Reads only. */
  metrics: z.array(z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(2).max(80),
  })).min(2),
  signals: z.array(z.enum(["weather", "seasonal", "reservice", "new_mover", "permit"])).min(1),
  seasons: z.array(z.object({ month: z.number().int().min(1).max(12), label: z.string().min(2) })).optional(),
  rebookEveryDays: z.array(z.object({ serviceId: z.string(), days: z.number().int().positive(), label: z.string() })).optional(),
  watchLine: z.string().min(8),
});

export const REQUIRED_PACKS = [
  "roofing", "hvac", "plumbing", "electrical", "landscaping", "pest_control", "construction",
  "auto_repair", "tire_shop", "auto_glass", "moving", "duct_cleaning",
  "nail_salon", "hair_salon", "esthetics",
  "painting", "house_cleaning", "dog_grooming", "yoga_studio", "restaurant",
  "retail_shop", "ecommerce", "consulting", "tutoring", "childcare",
  "event_planner", "startup_saas", "startup_agency", "startup_dtc",
] as const;
