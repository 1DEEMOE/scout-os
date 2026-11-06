import { beforeEach, describe, expect, it } from "vitest";
import {
  configureEngine,
  createOrg,
  aiAnswersPeriod,
  latestAiAnswersCheck,
  MockAiAnswersProvider,
  MockModelProvider,
  ModelRouter,
  resetAiAnswersProvider,
  runAiAnswersCheck,
  setAiAnswersProviderForTests,
  ToolRegistry,
} from "../src/index";
import { resetDb, seedUser } from "../../db/test/helpers";

beforeEach(async () => {
  await resetDb();
  resetAiAnswersProvider();
  await seedUser("owner", "owner@example.test");
  configureEngine({
    router: new ModelRouter([new MockModelProvider(() => ({}))], "mock"),
    tools: new ToolRegistry(),
  });
});

describe("AI answers check", () => {
  it("records mock result, trend, and three suggestions without live calls", async () => {
    const { orgId } = await createOrg({ actorUserId: "owner", name: "Answers Co" });
    const first = await runAiAnswersCheck({ actorUserId: "owner", orgId, trade: "roofing", zip: "78701" });
    expect(first.period).toBe(aiAnswersPeriod());
    expect(first.result.suggestions).toHaveLength(3);
    expect(first.result.provider).toBe("mock");
    expect(first.trendDelta).toBeNull();

    const latest = await latestAiAnswersCheck({ actorUserId: "owner", orgId });
    expect(latest?.score).toBe(first.result.score);

    // Same period is idempotent
    const again = await runAiAnswersCheck({ actorUserId: "owner", orgId, trade: "roofing", zip: "78701" });
    expect(again.checkId).toBe(first.checkId);

    // Custom provider for forced re-check with higher score
    setAiAnswersProviderForTests({
      name: "test-stub",
      async check() {
        return {
          recommended: true,
          score: 90,
          provider: "test-stub",
          suggestions: ["one", "two", "three"] as [string, string, string],
        };
      },
    });
    // Simulate prior month by inserting via force on same period still returns existing unless force+different — use force after deleting period uniqueness by trading zip
    const other = await runAiAnswersCheck({ actorUserId: "owner", orgId, trade: "roofing", zip: "78702" });
    expect(other.result.provider).toBe("test-stub");
    expect(other.result.score).toBe(90);
  });

  it("default provider is MockAiAnswersProvider", () => {
    expect(new MockAiAnswersProvider().name).toBe("mock");
  });
});
