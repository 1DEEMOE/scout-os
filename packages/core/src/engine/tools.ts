import { z } from "zod";

export type Tier = 0 | 1 | 2 | 3 | 4;

export const TIER_LABEL: Record<Tier, string> = {
  0: "read-only",
  1: "internal write",
  2: "external communication",
  3: "financial or contractual",
  4: "destructive or privileged",
};

export interface ToolContext {
  tenantId: string;
  taskId: string;
  agentId: string;
  /** Stable across retries of the same step. Pass it to the provider when it supports one. */
  idempotencyKey: string;
}

/** Thrown by tools. `retryable` errors move the task to RETRY_SCHEDULED. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code = "TOOL_ERROR",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolDefinition<Args = unknown, Out = unknown> {
  name: string;
  description: string;
  tier: Tier;
  args: z.ZodType<Args>;
  /** One line a human reads on the approval screen. */
  summarize(args: Args): string;
  /** Labelled true when the tool talks to a fake provider, so the UI can show MOCK. */
  mock?: boolean;
  execute(ctx: ToolContext, args: Args): Promise<Out>;
  /**
   * After a crash mid-call, asks the provider whether the call with this key
   * already happened. Returns the earlier output, or undefined if it didn't.
   */
  reconcile?(ctx: ToolContext, args: Args): Promise<Out | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(...tools: AnyTool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`tool ${t.name} registered twice`);
      this.tools.set(t.name, t);
    }
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** JSON Schema descriptions for the model, limited to the given names. */
  specs(names: readonly string[]): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return names
      .map((n) => this.tools.get(n))
      .filter((t): t is AnyTool => !!t)
      .map((t) => ({
        name: t.name,
        description: `${t.description} (risk tier ${t.tier}: ${TIER_LABEL[t.tier]})`,
        // The model sees the input shape; transforms (e.g. lowercasing) happen after validation.
        inputSchema: z.toJSONSchema(t.args, { io: "input" }) as Record<string, unknown>,
      }));
  }
}
