import {
  AnthropicProvider,
  gmailMailboxResolver,
  hubspotCrmResolver,
  stripeInvoicingResolver,
  configureEngine,
  logger,
  meteringHooks,
  MockLedger,
  MockModelProvider,
  mockLeadBotPlan,
  mockTools,
  ModelRouter,
  ToolRegistry,
  UnconfiguredProvider,
  fetchNwsAlerts,
  registerBusHandler,
  type ModelProvider,
} from "@wos/core";
import { registerProductTools } from "./tools";

let configured = false;
let status: "live" | "mock" | "none" = "none";

/** What kind of AI model this process uses, for banners in the UI. */
export function modelStatus(): "live" | "mock" | "none" {
  ensureEngine();
  return status;
}

/**
 * Wires the engine for this process (web server or worker). Real providers
 * are used when their credentials are set. WOS_MOCK_MODE=1 adds MOCK tools and
 * a MOCK model for local demos; everything they do is labelled MOCK.
 */
export function ensureEngine(): void {
  if (configured) return;
  const mockMode = process.env.WOS_MOCK_MODE === "1";
  const tools = new ToolRegistry();
  const mailbox = gmailMailboxResolver;
  const crm = hubspotCrmResolver;
  const invoicing = stripeInvoicingResolver;
  registerProductTools(tools, { mailbox, crm, invoicing });
  if (mockMode) tools.register(...mockTools(new MockLedger()));

  const providers: ModelProvider[] = [];
  let defaultProvider: string;
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
    defaultProvider = "anthropic";
    status = "live";
  } else if (mockMode) {
    providers.push(
      new MockModelProvider((req) =>
        req.purpose === "classify" ? { text: "inbox" } : req.purpose === "lead.plan" ? mockLeadBotPlan(req) : { text: "MOCK model: no AI provider is configured, so no actions were proposed." },
      ),
    );
    defaultProvider = "mock";
    status = "mock";
  } else {
    providers.push(new UnconfiguredProvider());
    defaultProvider = "none";
    status = "none";
  }
  configureEngine({ router: new ModelRouter(providers, defaultProvider, meteringHooks), tools, mailbox, crm, invoicing });
  registerBusHandler({
    type: "weather.refresh",
    maxTier: 0,
    decide: () => ({ act: true, reason: "refresh public alerts" }),
    async act() {
      const r = await fetchNwsAlerts();
      return { count: r.alerts.length, degraded: r.degraded === true };
    },
    verify: (_event, result) => typeof result.count === "number",
  });
  logger.info({ model: defaultProvider, mockMode, tools: tools.list().map((t) => t.name) }, "engine configured");
  configured = true;
}

/** For tests only. */
export function resetEngineForTests(): void {
  configured = false;
}
