/**
 * Pluggable provider for "are we recommended for this trade + ZIP in AI answers?"
 * Production may plug in a real provider later; tests and WOS_MOCK_MODE use Mock.
 * No live network calls from the mock.
 */
export interface AiAnswersQuery {
  trade: string;
  zip: string;
  businessName?: string;
}

export interface AiAnswersResult {
  recommended: boolean;
  score: number; // 0-100
  provider: string;
  /** Exactly three plain-language fix suggestions when not fully recommended. */
  suggestions: [string, string, string];
}

export interface AiAnswersProvider {
  readonly name: string;
  check(query: AiAnswersQuery): Promise<AiAnswersResult>;
}

/** Deterministic mock: score from trade+zip hash; never calls the network. */
export class MockAiAnswersProvider implements AiAnswersProvider {
  readonly name = "mock";
  async check(query: AiAnswersQuery): Promise<AiAnswersResult> {
    const seed = [...`${query.trade}|${query.zip}|${query.businessName ?? ""}`].reduce((a, c) => a + c.charCodeAt(0), 0);
    const score = seed % 101;
    const recommended = score >= 55;
    const suggestions: [string, string, string] = recommended
      ? [
          "Keep your Google Business profile hours and service area up to date.",
          "Ask happy customers for a short review that names your trade and city.",
          "Publish one clear page that lists the ZIP codes you serve.",
        ]
      : [
          "Add your trade and city to your homepage title and first paragraph.",
          "Claim and complete your Google Business profile with real photos of recent jobs.",
          "List the ZIP codes you cover on a single, easy-to-find service-area page.",
        ];
    return { recommended, score, provider: this.name, suggestions };
  }
}

let provider: AiAnswersProvider = new MockAiAnswersProvider();

export function getAiAnswersProvider(): AiAnswersProvider {
  return provider;
}

/** Tests / future wiring. Never use a live provider when WOS_MOCK_MODE=1. */
export function setAiAnswersProviderForTests(p: AiAnswersProvider): void {
  provider = p;
}

export function resetAiAnswersProvider(): void {
  provider = new MockAiAnswersProvider();
}
