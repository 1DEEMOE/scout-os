import Anthropic from "@anthropic-ai/sdk";

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  /** Which call this is, for logs and metering: "classify", "plan", ... */
  purpose: string;
  tenantId: string;
  system: string;
  messages: ModelMessage[];
  tools?: ModelToolSpec[];
  maxTokens?: number;
  model?: string;
  /** For metering. */
  taskId?: string;
  agentId?: string;
}

export interface ModelResponse {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
}

export interface ModelProvider {
  readonly name: string;
  /** True for providers that never call a real model. Shown as MOCK in the UI. */
  readonly mock: boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export type UsageHook = (req: ModelRequest, res: ModelResponse) => Promise<void>;
export type BudgetHook = (req: ModelRequest) => Promise<void>;

/**
 * The single internal interface for model calls. Agents never import a
 * provider SDK directly; swapping or adding providers happens here.
 */
export class ModelRouter {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    providers: ModelProvider[],
    private readonly defaultProvider: string,
    private readonly hooks: { beforeCall?: BudgetHook; afterCall?: UsageHook } = {},
  ) {
    for (const p of providers) this.providers.set(p.name, p);
    if (!this.providers.has(defaultProvider)) throw new Error(`default provider ${defaultProvider} not registered`);
  }

  get isMock(): boolean {
    return this.providers.get(this.defaultProvider)!.mock;
  }

  async complete(req: ModelRequest, providerName?: string): Promise<ModelResponse> {
    const provider = this.providers.get(providerName ?? this.defaultProvider) ?? this.providers.get(this.defaultProvider)!;
    await this.hooks.beforeCall?.(req);
    const res = await provider.complete(req);
    await this.hooks.afterCall?.(req, res);
    return res;
  }
}

/**
 * MOCK provider for tests and local demos. Never calls a real model; replies
 * come from the script function the test supplies.
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock";
  readonly mock = true;
  readonly calls: ModelRequest[] = [];

  constructor(private readonly script: (req: ModelRequest) => Partial<ModelResponse> | Promise<Partial<ModelResponse>>) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const r = await this.script(req);
    return {
      text: r.text ?? "",
      toolCalls: r.toolCalls ?? [],
      usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
      provider: "mock",
      model: "mock",
    };
  }
}

/**
 * Anthropic provider. UNVERIFIED in this repo so far: no API key has been
 * available in any build session. Covered by a request-shape unit test only.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly mock = false;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly defaultModel = process.env.MODEL_DEFAULT ?? "claude-sonnet-5-5",
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const model = req.model ?? this.defaultModel;
    const res = await this.client.messages.create({
      model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: req.messages,
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const toolCalls = res.content.flatMap((b) => (b.type === "tool_use" ? [{ name: b.name, input: b.input }] : []));
    return {
      text,
      toolCalls,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      provider: this.name,
      model,
    };
  }
}

/** Used when no model provider is configured. Every call fails with a clear reason. */
export class UnconfiguredProvider implements ModelProvider {
  readonly name = "none";
  readonly mock = false;
  async complete(): Promise<ModelResponse> {
    throw Object.assign(new Error("No AI model provider is configured (set ANTHROPIC_API_KEY)"), { code: "MODEL_NOT_CONFIGURED" });
  }
}
