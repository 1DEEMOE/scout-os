import type { ElitePack } from "./schema";
import { MOVING_ELITE } from "./moving";

export * from "./schema";
export * from "./engine";

/** Elite packs layered on overlays by id. Packs not listed here stay "credible" v1 packs. */
export const ELITE_PACKS: Readonly<Record<string, ElitePack>> = { moving: MOVING_ELITE };

export const getElitePack = (id: string): ElitePack | undefined => ELITE_PACKS[id];
export const hasElitePack = (id: string): boolean => id in ELITE_PACKS;
