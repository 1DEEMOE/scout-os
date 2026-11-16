import { getEngine } from "../engine/runtime";
import type { ModelRouter } from "../engine/router";
import { logger } from "../logger";
import { getAiAnswersProvider, MockAiAnswersProvider, type AiAnswersProvider, type AiAnswersQuery, type AiAnswersResult } from "./provider";

/**
 * Live "are we recommended in AI answers?" measurement.
 *
 * Unlike the mock (a hash of the query), this actually asks an answer engine:
 * one web-search-grounded completion through the model router, then a
 * deterministic parse + score of the business names it returned. The model
 * never decides the score — it only produces the candidate list; parsing,
 * matching, scoring, and the three suggestions are plain code, so a weird
 * answer can lower the score, never fabricate one.
 *
 * Cost discipline: purpose "classify" routes to the cheap model, the call is
 * wrapped by the router's budget reserve and usage metering, and the whole
 * path is opt-in via AI_ANSWERS_PROVIDER=anthropic-websearch (an owner
 * decision — it spends money against a live model). In WOS_MOCK_MODE, or
 * without that opt-in, or without a live router, the mock provider answers.
 */

export const LIVE_PROVIDER_NAME = "anthropic-websearch";

/** Pulls the first JSON string array out of a completion. Garbage in → []. */
export function parseNameList(text: string, max = 20): string[] {
  const m = /\[[\s\S]*?\]/.exec(text);
  if (!m) return [];
  try {
    const parsed: unknown = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean).slice(0, max);
  } catch {
    return [];
  }
}

/** Lowercase, drop punctuation and common company suffixes, collapse spaces. */
export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(llc|inc|co|company|corp|corporation|ltd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(business: string, candidate: string): boolean {
  const b = normalizeBusinessName(business);
  const c = normalizeBusinessName(candidate);
  if (!b || !c) return false;
  if (b === c) return true;
  // Containment both ways handles "Peachtree Roofing" vs "Peachtree Roofing
  // & Gutters". Below 3 characters a substring "match" is noise ("a" is in
  // "zeta"), so tiny names only ever match exactly.
  if (b.length < 3 || c.length < 3) return false;
  return b.includes(c) || c.includes(b);
}

export interface PresenceScore {
  mentioned: boolean;
  position: number | null;
  candidateCount: number;
  score: number;
  recommended: boolean;
}

/**
 * Score from where the business appears in the answer's own list:
 * first mention 100 down to 70 for a late mention; named nowhere but the
 * engine listed competitors → 25; the engine had no answer at all → 10.
 */
export function scorePresence(businessName: string | undefined, candidates: string[]): PresenceScore {
  const position = businessName ? candidates.findIndex((c) => nameMatches(businessName, c)) : -1;
  const mentioned = position >= 0;
  const score = mentioned ? Math.max(70, 100 - position * 5) : candidates.length > 0 ? 25 : 10;
  return { mentioned, position: mentioned ? position : null, candidateCount: candidates.length, score, recommended: score >= 55 };
}

/** Deterministic advice, same three-part contract as the mock. */
export function suggestionsFor(r: PresenceScore): [string, string, string] {
  if (r.mentioned && r.position !== null && r.position <= 2) {
    return [
      "Keep your Google Business profile hours and service area up to date.",
      "Ask happy customers for a short review that names your trade and city.",
      "Publish one clear page that lists the ZIP codes you serve.",
    ];
  }
  if (r.mentioned) {
    return [
      "Collect a few more recent reviews that name your trade and city — you appear, but below others.",
      "Make your homepage name, trade, and city match your Google Business profile exactly.",
      "Add real photos of recent jobs to your business profile.",
    ];
  }
  return [
    "Add your trade and city to your homepage title and first paragraph.",
    "Claim and complete your Google Business profile with real photos of recent jobs.",
    "List the ZIP codes you cover on a single, easy-to-find service-area page.",
  ];
}

export class LiveAiAnswersProvider implements AiAnswersProvider {
  readonly name = LIVE_PROVIDER_NAME;

  constructor(private readonly router: ModelRouter) {}

  async check(query: AiAnswersQuery): Promise<AiAnswersResult> {
    if (!query.tenantId) throw new Error("live AI-answers checks need a tenantId");
    const res = await this.router.complete({
      purpose: "classify", // cheap model; the answer is a short list, not reasoning
      tenantId: query.tenantId,
      system:
        "You measure local business visibility. Answer the user's question with ONLY a JSON array of business names you would actually recommend, best first, e.g. [\"Acme Roofing\", \"Bob's Roofs\"]. No prose, no numbering, no commentary. If you cannot name any real business, answer [].",
      messages: [
        {
          role: "user",
          content: `Which ${query.trade.slice(0, 80)} companies do you recommend for a homeowner near ZIP code ${query.zip}?`,
        },
      ],
      serverTools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      maxTokens: 512,
    });
    const candidates = parseNameList(res.text);
    const presence = scorePresence(query.businessName, candidates);
    return { recommended: presence.recommended, score: presence.score, provider: this.name, suggestions: suggestionsFor(presence) };
  }
}

let liveRouter: ModelRouter | undefined;

/** Tests and startup wiring can pin the router used for live checks. */
export function setAiAnswersLiveRouter(router: ModelRouter | undefined): void {
  liveRouter = router;
}

/**
 * The provider for a tenant's check: live only when explicitly opted in and a
 * non-mock router exists; the labelled mock otherwise. Never throws — a
 * broken live setup must degrade to the mock, not break the briefing.
 */
export function providerForAiAnswers(): AiAnswersProvider {
  try {
    const pinned = getAiAnswersProvider();
    if (pinned.name !== "mock") return pinned; // a test or integration pinned a provider
    if (process.env.WOS_MOCK_MODE === "1") return pinned;
    if (process.env.AI_ANSWERS_PROVIDER !== LIVE_PROVIDER_NAME) return pinned;
    const router = liveRouter ?? getEngine().router;
    if (router.isMock) return pinned;
    return new LiveAiAnswersProvider(router);
  } catch (err) {
    logger.warn({ err }, "live AI-answers provider unavailable; using mock");
    return new MockAiAnswersProvider();
  }
}
