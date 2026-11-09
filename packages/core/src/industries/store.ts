import { and, eq } from "drizzle-orm";
import { memoryRecords, type Tx } from "@wos/db";
import { AppError } from "../errors";
import { getPack, isPackId, type IndustryPack } from "./packs";

const SCOPE = "speed:pack";

/** The applied organizations.industry check only allows these two values. */
export function legacyColumn(pack: IndustryPack): "roofing" | "general" {
  return pack.legacyColumn;
}

export function requirePack(id: string): IndustryPack {
  if (!isPackId(id)) throw new AppError("VALIDATION", "Pick an industry from the list.");
  return getPack(id);
}

export async function readPackId(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ content: memoryRecords.content }).from(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, SCOPE))).limit(1);
  if (!row) return null;
  try {
    const id = (JSON.parse(row.content) as { id?: string }).id;
    return id && isPackId(id) ? id : null;
  } catch {
    return null;
  }
}

export async function writePackId(tx: Tx, tenantId: string, packId: string, userId: string): Promise<void> {
  requirePack(packId);
  await tx.delete(memoryRecords).where(and(eq(memoryRecords.layer, "org"), eq(memoryRecords.scopeRef, SCOPE)));
  await tx.insert(memoryRecords).values({
    tenantId,
    layer: "org",
    scopeRef: SCOPE,
    content: JSON.stringify({ version: 1, id: packId }),
    trust: "user",
    createdByUser: userId,
  });
}
