/**
 * Purpose → model name. Mock mode does not select a live model.
 * Prices stay in billing/metering.ts; this only picks the name the provider would use.
 */
export function modelForPurpose(purpose: string): string | undefined {
  if (process.env.WOS_MOCK_MODE === "1") return undefined;
  const cheap = process.env.MODEL_CHEAP || "claude-haiku-4-5";
  const strong = process.env.MODEL_STRONG || process.env.MODEL_DEFAULT || "claude-sonnet-5-5";
  if (purpose === "classify" || purpose === "summarize" || purpose === "route") return cheap;
  return strong;
}
