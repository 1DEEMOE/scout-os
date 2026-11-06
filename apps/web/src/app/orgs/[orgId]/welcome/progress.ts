/** The three quick steps and a plain time estimate for each point in them. */
export const QUICKSTART_STEPS = [
  { n: 1, title: "Your business", minutesLeft: 5 },
  { n: 2, title: "Connect your email", minutesLeft: 3 },
  { n: 3, title: "What Scout should watch", minutesLeft: 1 },
] as const;

export function stepFromOnboarding(step: string | null): 1 | 2 | 3 {
  if (step === "connect") return 2;
  if (step === "invite" || step === "data" || step === "finish") return 3;
  return 1;
}

export function quickstartProgress(step: string | null): { done: number; nextLabel: string; minutesLeft: number } {
  const current = stepFromOnboarding(step);
  const s = QUICKSTART_STEPS[current - 1]!;
  return { done: current - 1, nextLabel: s.title, minutesLeft: s.minutesLeft };
}

export const minutesText = (m: number) => (m <= 1 ? "about a minute left" : `about ${m} minutes left`);
