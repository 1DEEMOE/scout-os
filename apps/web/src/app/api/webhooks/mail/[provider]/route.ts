import { handleMailEvent, parsePostmarkEvent, platformSuppressionStore, webhookSecretOk } from "@wos/core";
import { logger } from "@wos/core";
import { PUBLIC_MAX_BODY_BYTES } from "@/server/public-api";

export const dynamic = "force-dynamic";

/**
 * Provider bounce/complaint webhooks for platform email (Postmark today).
 * Auth: a shared secret, checked constant-time, supplied either as the
 * `x-mail-webhook-secret` header or as the password in the webhook URL's basic
 * auth (`https://anything:SECRET@host/api/webhooks/mail/postmark`).
 *
 * Answers 503 while the durable suppression store (proposed migration 0025) is
 * unavailable, so the provider keeps retrying instead of events being lost.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "postmark") return new Response("Unknown provider", { status: 404 });

  const secret = process.env.MAIL_WEBHOOK_SECRET;
  if (!secret) return new Response("Not found", { status: 404 }); // route is dark until configured

  const headerSecret = req.headers.get("x-mail-webhook-secret");
  let basicSecret: string | null = null;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      basicSecret = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
    } catch {
      basicSecret = null;
    }
  }
  if (!webhookSecretOk(headerSecret, secret) && !webhookSecretOk(basicSecret, secret)) {
    return new Response("Forbidden", { status: 403 });
  }

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > PUBLIC_MAX_BODY_BYTES) return new Response("Request too large", { status: 413 });
  const text = await req.text();
  if (Buffer.byteLength(text) > PUBLIC_MAX_BODY_BYTES) return new Response("Request too large", { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const { store, durable } = await platformSuppressionStore();
  if (!durable) return new Response("Suppression store unavailable", { status: 503 });

  const event = parsePostmarkEvent(body);
  if (!event) return new Response("Ignored", { status: 202 }); // receipts, opens, unknown types

  const outcome = await handleMailEvent(store, event);
  // Never log the address: it's personal data. Kind + outcome is enough to alert on.
  logger.info({ mail: { kind: event.kind, provider: event.provider, outcome } }, "platform mail suppression event");
  return new Response("OK", { status: 200 });
}
