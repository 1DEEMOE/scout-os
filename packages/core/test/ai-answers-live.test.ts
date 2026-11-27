import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  LIVE_PROVIDER_NAME,
  LiveAiAnswersProvider,
  MockModelProvider,
  ModelRouter,
  normalizeBusinessName,
  parseNameList,
  providerForAiAnswers,
  resetAiAnswersProvider,
  scorePresence,
  setAiAnswersLiveRouter,
  setAiAnswersProviderForTests,
  suggestionsFor,
  UnconfiguredProvider,
  type ModelRequest,
} from "../src/index";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env.WOS_MOCK_MODE = ORIGINAL_ENV.WOS_MOCK_MODE;
  if (ORIGINAL_ENV.AI_ANSWERS_PROVIDER === undefined) delete process.env.AI_ANSWERS_PROVIDER;
  else process.env.AI_ANSWERS_PROVIDER = ORIGINAL_ENV.AI_ANSWERS_PROVIDER;
  setAiAnswersLiveRouter(undefined);
  resetAiAnswersProvider();
});

describe("parseNameList", () => {
  it("parses a clean JSON array", () => {
    expect(parseNameList('["Acme Roofing", "Bob\'s Roofs"]')).toEqual(["Acme Roofing", "Bob's Roofs"]);
  });

  it("extracts the first array out of surrounding prose", () => {
    expect(parseNameList('Sure! Here you go: ["Acme"] — hope that helps.')).toEqual(["Acme"]);
  });

  it("returns [] for garbage and broken JSON", () => {
    expect(parseNameList("I cannot name any.")).toEqual([]);
    expect(parseNameList('["Acme",')).toEqual([]);
  });

  it("still finds the array when the model wraps it in an object", () => {
    expect(parseNameList('{"names": ["Acme"]}')).toEqual(["Acme"]);
  });

  it("drops non-strings, trims, blanks, and caps the list", () => {
    expect(parseNameList('["  Acme  ", 42, "", null, "Bob"]')).toEqual(["Acme", "Bob"]);
    expect(parseNameList('["a","b","c"]', 2)).toEqual(["a", "b"]);
  });
});

describe("normalizeBusinessName", () => {
  it("strips punctuation, case, and company suffixes", () => {
    expect(normalizeBusinessName("Peachtree Roofing, LLC")).toBe("peachtree roofing");
    expect(normalizeBusinessName("ACME Roofing Inc.")).toBe("acme roofing");
    expect(normalizeBusinessName("Bob's   Roofing Co")).toBe("bob s roofing");
  });
});

describe("scorePresence", () => {
  const candidates = ["Alpha Roofing", "Beta Roofing", "Gamma Roofing", "Delta Roofing"];

  it("scores 100 for the first mention and recommends", () => {
    const r = scorePresence("Alpha Roofing LLC", candidates);
    expect(r).toMatchObject({ mentioned: true, position: 0, score: 100, recommended: true });
  });

  it("decays 5 points per position, floored at 70 for any mention", () => {
    expect(scorePresence("Delta Roofing", candidates).score).toBe(85);
    const late = ["a", "b", "c", "d", "e", "f", "g", "Zeta Roofing"];
    expect(scorePresence("Zeta Roofing", late).score).toBe(70);
  });

  it("matches through containment both ways", () => {
    expect(scorePresence("Peachtree Roofing", ["Peachtree Roofing & Gutters LLC"]).mentioned).toBe(true);
    expect(scorePresence("Peachtree Roofing & Gutters", ["Peachtree Roofing"]).mentioned).toBe(true);
  });

  it("does not containment-match tiny names ('a' is inside 'zeta')", () => {
    expect(scorePresence("Zeta Roofing", ["a", "b"]).mentioned).toBe(false);
    expect(scorePresence("A", ["a"]).mentioned).toBe(true); // exact match still works
  });

  it("scores 25 when competitors are listed but the business is not", () => {
    const r = scorePresence("Unknown Roofing", candidates);
    expect(r).toMatchObject({ mentioned: false, position: null, candidateCount: 4, score: 25, recommended: false });
  });

  it("scores 10 when the engine named nobody at all", () => {
    expect(scorePresence("Unknown Roofing", []).score).toBe(10);
  });

  it("treats a missing business name as not mentioned", () => {
    expect(scorePresence(undefined, candidates)).toMatchObject({ mentioned: false, score: 25 });
  });
});

describe("suggestionsFor", () => {
  it("always returns exactly three suggestions for every branch", () => {
    expect(suggestionsFor(scorePresence("Alpha Roofing", ["Alpha Roofing"]))).toHaveLength(3);
    expect(suggestionsFor(scorePresence("Delta Roofing", ["a", "b", "c", "Delta Roofing"]))).toHaveLength(3);
    expect(suggestionsFor(scorePresence("Unknown Roofing", ["a"]))).toHaveLength(3);
  });
});

describe("LiveAiAnswersProvider", () => {
  function liveRouter(script: (req: ModelRequest) => { text: string }) {
    const model = new MockModelProvider(script);
    return { model, router: new ModelRouter([model], "mock") };
  }

  it("scores a real mention from the model's list, on the cheap purpose, with web search", async () => {
    const { model, router } = liveRouter(() => ({ text: '["Peachtree Roofing", "Other Roofers"]' }));
    const provider = new LiveAiAnswersProvider(router);
    const res = await provider.check({ trade: "roofing", zip: "30309", businessName: "Peachtree Roofing LLC", tenantId: "t1" });

    expect(res).toMatchObject({ recommended: true, score: 100, provider: LIVE_PROVIDER_NAME });
    expect(res.suggestions).toHaveLength(3);

    expect(model.calls).toHaveLength(1);
    const req = model.calls[0]!;
    expect(req.purpose).toBe("classify");
    expect(req.tenantId).toBe("t1");
    expect(req.maxTokens).toBe(512);
    expect(req.serverTools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
    expect(req.messages[0]?.content).toContain("30309");
  });

  it("scores 10 when the model answers with garbage", async () => {
    const { router } = liveRouter(() => ({ text: "I cannot browse the web." }));
    const res = await new LiveAiAnswersProvider(router).check({ trade: "roofing", zip: "30309", businessName: "Acme", tenantId: "t1" });
    expect(res).toMatchObject({ recommended: false, score: 10 });
  });

  it("refuses to run without a tenantId (metering and budget need it)", async () => {
    const { router } = liveRouter(() => ({ text: "[]" }));
    await expect(new LiveAiAnswersProvider(router).check({ trade: "roofing", zip: "30309" })).rejects.toThrow(/tenantId/);
  });
});

describe("providerForAiAnswers", () => {
  const liveishRouter = () => new ModelRouter([new UnconfiguredProvider()], "none"); // non-mock, never actually called here

  it("returns the labelled mock by default", () => {
    expect(providerForAiAnswers().name).toBe("mock");
  });

  it("keeps the mock in WOS_MOCK_MODE even when opted in with a live router", () => {
    process.env.WOS_MOCK_MODE = "1";
    process.env.AI_ANSWERS_PROVIDER = LIVE_PROVIDER_NAME;
    setAiAnswersLiveRouter(liveishRouter());
    expect(providerForAiAnswers().name).toBe("mock");
  });

  it("keeps the mock without the explicit opt-in, even with a live router", () => {
    delete process.env.WOS_MOCK_MODE;
    delete process.env.AI_ANSWERS_PROVIDER;
    setAiAnswersLiveRouter(liveishRouter());
    expect(providerForAiAnswers().name).toBe("mock");
  });

  it("keeps the mock when the router itself is a mock", () => {
    delete process.env.WOS_MOCK_MODE;
    process.env.AI_ANSWERS_PROVIDER = LIVE_PROVIDER_NAME;
    setAiAnswersLiveRouter(new ModelRouter([new MockModelProvider(() => ({}))], "mock"));
    expect(providerForAiAnswers().name).toBe("mock");
  });

  it("returns the live provider only when opted in with a non-mock router", () => {
    delete process.env.WOS_MOCK_MODE;
    process.env.AI_ANSWERS_PROVIDER = LIVE_PROVIDER_NAME;
    setAiAnswersLiveRouter(liveishRouter());
    expect(providerForAiAnswers().name).toBe(LIVE_PROVIDER_NAME);
  });

  it("degrades to the mock when no engine/router exists instead of throwing", () => {
    delete process.env.WOS_MOCK_MODE;
    process.env.AI_ANSWERS_PROVIDER = LIVE_PROVIDER_NAME;
    expect(providerForAiAnswers().name).toBe("mock");
  });

  it("honors a provider pinned by a test or integration above everything", () => {
    delete process.env.WOS_MOCK_MODE;
    process.env.AI_ANSWERS_PROVIDER = LIVE_PROVIDER_NAME;
    setAiAnswersLiveRouter(liveishRouter());
    setAiAnswersProviderForTests({
      name: "test-stub",
      async check() {
        return { recommended: true, score: 90, provider: "test-stub", suggestions: ["a", "b", "c"] };
      },
    });
    expect(providerForAiAnswers().name).toBe("test-stub");
  });
});

describe("AnthropicProvider server tools", () => {
  function fakeClient() {
    const calls: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { content: [{ type: "text", text: '["Acme"]' }], usage: { input_tokens: 3, output_tokens: 7 } };
        },
      },
    } as unknown as Anthropic;
    return { calls, client };
  }

  it("merges client tools and server tools into one tools array", async () => {
    const { calls, client } = fakeClient();
    const provider = new AnthropicProvider("sk-test", "test-model", client);
    const res = await provider.complete({
      purpose: "classify",
      tenantId: "t1",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }],
      serverTools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    });

    const tools = calls[0]!.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: "lookup", input_schema: { type: "object" } });
    expect(tools[1]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    expect(res).toMatchObject({ text: '["Acme"]', provider: "anthropic", model: "test-model" });
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
  });

  it("omits the tools param entirely when there are none", async () => {
    const { calls, client } = fakeClient();
    const provider = new AnthropicProvider("sk-test", "test-model", client);
    await provider.complete({ purpose: "classify", tenantId: "t1", system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]!.tools).toBeUndefined();
  });
});
