import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError, createCheckout, listMyOrgs, planCatalog } from "@wos/core";
import { getSessionUserId } from "@/server/auth";

export const dynamic = "force-dynamic";

const card = "mx-auto flex max-w-md flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-7";

/**
 * Turns a "Choose plan" click into a Stripe Checkout session.
 *
 * Anonymous visitors go to sign-up first and come back here afterwards
 * (?next= round-trip). Members with no organization create one first; with
 * exactly one, checkout starts immediately; with several, they pick which
 * workspace the subscription is for.
 */
export default async function PricingStartPage({ searchParams }: { searchParams: Promise<{ plan?: string; org?: string }> }) {
  const { plan, org } = await searchParams;
  const known = plan ? planCatalog().some((p) => p.id === plan) : false;
  if (!plan || !known) redirect("/pricing");

  const userId = await getSessionUserId(await headers());
  if (!userId) redirect(`/sign-up?next=${encodeURIComponent(`/pricing/start?plan=${plan}`)}`);

  const orgs = await listMyOrgs({ actorUserId: userId });
  if (orgs.length === 0) redirect(`/orgs?next=${encodeURIComponent(`/pricing/start?plan=${plan}`)}`);

  const chosen = org ? orgs.find((o) => o.orgId === org) : orgs.length === 1 ? orgs[0] : undefined;
  if (!chosen) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold">Which workspace is this plan for?</h1>
        <ul className="flex flex-col gap-2">
          {orgs.map((o) => (
            <li key={o.orgId}>
              <a className="flex min-h-11 items-center justify-between rounded-lg border border-line px-4 hover:bg-line/40" href={`/pricing/start?plan=${plan}&org=${o.orgId}`}>
                <span className="font-medium">{o.name}</span>
                <span className="text-xs uppercase tracking-wide text-muted">{o.role}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const base = process.env.BETTER_AUTH_URL ?? `https://${(await headers()).get("host")}`;
  try {
    const { url } = await createCheckout({ actorUserId: userId, orgId: chosen.orgId, plan, returnUrl: `${base}/orgs/${chosen.orgId}/billing` });
    redirect(url);
  } catch (err) {
    if (err instanceof AppError) {
      return (
        <div className={card}>
          <h1 className="text-xl font-semibold">Checkout isn&apos;t available</h1>
          <p className="text-sm leading-relaxed text-muted">{err.message}</p>
          <a className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4" href="/pricing">Back to plans</a>
        </div>
      );
    }
    throw err;
  }
}
