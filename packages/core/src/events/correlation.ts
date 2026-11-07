import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../logger";

export interface Correlation {
  id: string;
  actorId?: string;
}

export const correlation = new AsyncLocalStorage<Correlation>();

export function inputHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * One structured line for an operation. The input is hashed, never written.
 * scrubPii still runs inside the logger.
 */
export function logOp(fields: {
  message: string;
  tenantId?: string;
  actorId?: string;
  agentId?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  durationMs?: number;
  outcome: "success" | "error" | "denied" | "degraded";
  failure?: string;
  recovery?: string;
  correlationId?: string;
}): void {
  const store = correlation.getStore();
  logger.info(
    {
      correlationId: fields.correlationId ?? store?.id,
      tenantId: fields.tenantId,
      actorId: fields.actorId ?? store?.actorId,
      agentId: fields.agentId,
      tool: fields.tool,
      inputHash: fields.input === undefined ? undefined : inputHash(fields.input),
      output: fields.output?.slice(0, 200),
      durationMs: fields.durationMs,
      outcome: fields.outcome,
      failure: fields.failure?.slice(0, 300),
      recovery: fields.recovery,
    },
    fields.message,
  );
}
