import { describe, expect, it } from "vitest";
import { runGuardrailChecks } from "../evals/checks";

/**
 * CI enforcement for the guardrail evals (packages/core/evals). Every check
 * must pass; the CLI (pnpm --filter @wos/core evals) prints the same report.
 */
describe("guardrail evals", () => {
  const results = runGuardrailChecks();
  it("covers taint, wrapping, policy, and payment floors", () => {
    expect(new Set(results.map((r) => r.suite))).toEqual(new Set(["taint", "wrapping", "policy", "payment"]));
    expect(results.length).toBeGreaterThanOrEqual(15);
  });
  it.each(results.map((r) => [r.suite, r.id, r.pass] as const))("%s / %s", (_suite, _id, pass) => {
    expect(pass).toBe(true);
  });
});
