import { AppError } from "../../errors";
import { roofing } from "./roofing";
import type { Vertical } from "./types";

export * from "./types";

const REGISTRY: Record<string, Vertical> = { roofing };

export function vertical(id: string): Vertical {
  const v = REGISTRY[id];
  if (!v) throw new AppError("VALIDATION", `Vertical ${id} isn't available.`);
  return v;
}

export const activeVerticals = (): Vertical[] => Object.values(REGISTRY);
