/**
 * Industry presets for the plug-and-play setup wizard.
 *
 * Presets configure agents, approval defaults (never looser than current rules),
 * routines, pipeline stages, and plan entitlements. They do NOT mute pause-all,
 * consent, suppression, or tier gates.
 */

import { getPack, isPackId, type IndustryPack } from "../industries/packs";

export type IndustryId = IndustryPack["id"];

export type ConnectorId = 'gmail' | 'hubspot' | 'stripe' | 'quickbooks';

export interface IndustryPreset {
  id: string;
  label: string;
  tagline: string;
  /** Plan applied during trial onboarding (audited). Never free for roofing Scout. */
  trialPlan: 'scout_pro' | 'growth' | 'starter';
  /** Features to surface on the dashboard / checklist. */
  featuredAgents: Array<'scout' | 'inbox' | 'pipeline' | 'followup' | 'billing' | 'coordinator'>;
  /** Default Morning Briefing cron (local wall clock; timezone applied at create). */
  morningBriefingHourLocal: number;
  morningBriefingMinuteLocal: number;
  /** Suggested pipeline stages (CRM already has defaults; this is UI guidance). */
  pipelineStages: string[];
  /** Scout service-area defaults for roofing. */
  defaultServicesOffered: string[];
  idealCustomerNotes: string;
  connectors: Array<{ id: ConnectorId; label: string; required: false; placeholder?: boolean }>;
  /** Wizard steps shown (order). */
  steps: Array<'industry' | 'basics' | 'data' | 'connect' | 'invite' | 'finish'>;
}

export const INDUSTRY_PRESETS: Record<"roofing" | "general", IndustryPreset> = {
  roofing: {
    id: 'roofing',
    label: 'Roofing',
    tagline: 'Storm leads → inbox → pipeline → billing, with human approvals.',
    trialPlan: 'scout_pro',
    featuredAgents: ['scout', 'inbox', 'pipeline', 'followup', 'billing', 'coordinator'],
    morningBriefingHourLocal: 7,
    morningBriefingMinuteLocal: 0,
    pipelineStages: ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
    defaultServicesOffered: ['roof_repair', 'roof_replacement', 'emergency', 'inspection'],
    idealCustomerNotes:
      'Homeowners and property managers in the service area with recent hail/wind damage. Prefer insured claims.',
    connectors: [
      { id: 'gmail', label: 'Gmail', required: false },
      { id: 'hubspot', label: 'HubSpot', required: false },
      { id: 'stripe', label: 'Stripe', required: false },
      { id: 'quickbooks', label: 'QuickBooks', required: false, placeholder: true },
    ],
    steps: ['industry', 'basics', 'data', 'connect', 'invite', 'finish'],
  },
  general: {
    id: 'general',
    label: 'General SMB',
    tagline: 'Inbox, pipeline, follow-up and billing for any small team.',
    trialPlan: 'growth',
    featuredAgents: ['inbox', 'pipeline', 'followup', 'billing', 'coordinator'],
    morningBriefingHourLocal: 7,
    morningBriefingMinuteLocal: 0,
    pipelineStages: ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
    defaultServicesOffered: [],
    idealCustomerNotes: '',
    connectors: [
      { id: 'gmail', label: 'Gmail', required: false },
      { id: 'hubspot', label: 'HubSpot', required: false },
      { id: 'stripe', label: 'Stripe', required: false },
      { id: 'quickbooks', label: 'QuickBooks', required: false, placeholder: true },
    ],
    steps: ['industry', 'basics', 'data', 'connect', 'invite', 'finish'],
  },
};

export function getPreset(industry: IndustryId): IndustryPreset {
  if (industry === "roofing" || industry === "general") return INDUSTRY_PRESETS[industry];
  if (!isPackId(industry)) return INDUSTRY_PRESETS.general;
  const pack = getPack(industry);
  return {
    ...INDUSTRY_PRESETS.general,
    id: industry,
    label: pack.label,
    tagline: pack.summary,
    trialPlan: pack.trialPlan,
    pipelineStages: [...pack.pipeline],
    defaultServicesOffered: pack.services.map((s) => s.id),
    idealCustomerNotes: pack.summary,
  };
}

export const ONBOARDING_STEPS = [
  'industry',
  'basics',
  'data',
  'connect',
  'invite',
  'finish',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];
