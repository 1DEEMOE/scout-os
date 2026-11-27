import type { Metadata } from "next";
import { logger, planCatalog, pricingCards, type PricingCard } from "@wos/core";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pricing" };

const card = "flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-7";

function limitText(n: number | null, unit: string): string {
  return n === null ? `Unlimited ${unit}` : `${n.toLocaleString("en-US")} ${unit}`;
}

/** What's in a plan, derived from the catalog itself — never hand-written marketing copy that can drift from enforcement. */
function planFacts(c: PricingCard): string[] {
  const facts = [
    limitText(c.plan.limits.seats, c.plan.limits.seats === 1 ? "seat" : "seats"),
    c.plan.limits.tasks === null ? "Unlimited tasks per month" : `${c.plan.limits.tasks.toLocaleString("en-US")} tasks per month`,
    c.plan.limits.routines === null ? "Unlimited active routines" : `${c.plan.limits.routines} active routine${c.plan.limits.routines === 1 ? "" : "s"}`,
  ];
  if (c.plan.features.includes("scout")) facts.push("Scout lead intelligence with storm signals");
  if (c.plan.trialDays > 0) facts.push(`${c.plan.trialDays}-day free trial`);
  return facts;
}

function PriceLine({ c, degraded }: { c: PricingCard; degraded: boolean }) {
  if (degraded || !c.display) return <p className="text-lg font-medium text-muted">Price on request</p>;
  return (
    <p className="flex items-baseline gap-1">
      <span className="text-3xl font-semibold">{c.display.price}</span>
      <span className="text-muted">{c.display.period}</span>
    </p>
  );
}

/**
 * Public plan catalog. Prices come from PRICING_DISPLAY_JSON (owner config);
 * if that config is broken the page still renders, without prices, and the
 * error is logged — a bad env var must never take down the public site or
 * show an invented number.
 */
export default function PricingPage() {
  let cards: PricingCard[];
  let degraded = false;
  try {
    cards = pricingCards();
  } catch (err) {
    logger.error({ err }, "pricing display config is invalid; rendering without prices");
    degraded = true;
    cards = pricingCardsUnpriced();
  }
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-16">
      <header className="flex max-w-2xl flex-col gap-4">
        <p className="text-muted">Ascend Software</p>
        <h1 className="text-display font-semibold">Plans</h1>
        <p className="text-lg leading-relaxed text-muted">
          Every plan includes the approval gates, the audit log, and per-business data isolation. Reading and drafting run on their own; sending and paying always wait for a person.
        </p>
      </header>
      {degraded && (
        <p role="alert" className="rounded-md border border-warn/50 bg-warn/10 px-4 py-3 text-sm">
          Prices aren't available right now. The plans and limits below are accurate; check back for published pricing.
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <section key={c.plan.id} className={`${card} ${c.display?.highlight ? "border-accent ring-1 ring-accent" : ""}`} aria-label={c.plan.label}>
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{c.plan.label}</h2>
              {c.display?.highlight && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Most popular</span>}
            </div>
            <PriceLine c={c} degraded={degraded} />
            {c.display?.blurb && <p className="text-sm leading-relaxed text-muted">{c.display.blurb}</p>}
            <ul className="flex flex-col gap-2 text-sm leading-relaxed">
              {planFacts(c).map((f) => (
                <li key={f} className="flex gap-2"><span aria-hidden className="text-accent">✓</span>{f}</li>
              ))}
            </ul>
            <div className="mt-auto pt-2">
              {c.purchasable ? (
                <a className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-4 font-medium text-white" href={`/pricing/start?plan=${c.plan.id}`}>
                  Choose {c.plan.label}
                </a>
              ) : (
                <a className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-line px-4 font-medium" href={`/sign-up?next=/pricing`}>
                  Create an account
                </a>
              )}
            </div>
          </section>
        ))}
      </div>
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        Prices are set by the operator of this installation and shown exactly as configured; checkout is handled by Stripe.
        Need something larger, or a custom contract? The Enterprise plan is arranged directly — contact the team that runs this site.
      </p>
    </div>
  );
}

/** Catalog cards with no display config, used only when the pricing env var is malformed. */
function pricingCardsUnpriced(): PricingCard[] {
  // The plan catalog is separate from the display config and is not what threw.
  return planCatalog().map((plan) => ({ plan, display: null, purchasable: false }));
}
