import { handleStripeWebhook, logger, WebhookSignatureError } from "@wos/core";

export const dynamic = "force-dynamic";

/** Stripe needs the exact raw body to verify the signature, so read it as text. */
export async function POST(req: Request) {
  const body = await req.text();
  try {
    const result = await handleStripeWebhook(body, req.headers.get("stripe-signature"));
    return Response.json(result);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return new Response("Invalid signature", { status: 400 });
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "stripe webhook failed");
    // 500 makes Stripe retry later; processing is idempotent, so retries are safe.
    return new Response("Webhook processing failed", { status: 500 });
  }
}
