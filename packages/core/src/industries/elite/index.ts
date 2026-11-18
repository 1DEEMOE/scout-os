import type { ElitePack } from "./schema";
import { MOVING_ELITE } from "./moving";
import { HOUSE_CLEANING_ELITE } from "./house-cleaning";
import { HVAC_ELITE } from "./hvac";
import { PLUMBING_ELITE } from "./plumbing";

export * from "./schema";
export * from "./engine";

/** Elite packs layered on overlays by id. Packs not listed here stay "credible" v1 packs. */
export const ELITE_PACKS: Readonly<Record<string, ElitePack>> = {
  moving: MOVING_ELITE,
  house_cleaning: HOUSE_CLEANING_ELITE,
  hvac: HVAC_ELITE,
  plumbing: PLUMBING_ELITE,
};

export const getElitePack = (id: string): ElitePack | undefined => ELITE_PACKS[id];
export const hasElitePack = (id: string): boolean => id in ELITE_PACKS;
