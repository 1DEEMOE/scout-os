import { getChannelByToken } from "@wos/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * A machine-readable description of this business's booking endpoint, so other
 * AI assistants can find free times and request one for a customer. Every
 * request still lands in Scout's approvals: nothing is confirmed until someone
 * at the business says OK. Assistants must identify themselves.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ch = await getChannelByToken(token);
  if (!ch || ch.status !== "active") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const base = `${new URL(req.url).origin}/api/front-desk/${encodeURIComponent(token)}`;
  const doc = {
    openapi: "3.1.0",
    info: {
      title: `${ch.displayName}: booking requests`,
      version: "1",
      description:
        `Request an appointment with ${ch.displayName} on behalf of a customer. Requests are not confirmations: each one waits for a person at the business to approve it, and the customer hears back from them. ` +
        "AI assistants must send requesterKind \"ai_agent\" and their own name in agentName, and must have shown the customer the disclosure below (disclosureAck: true). " +
        `Disclosure: ${ch.disclosure}`,
    },
    servers: [{ url: base }],
    paths: {
      "/availability": {
        get: {
          operationId: "listAvailability",
          summary: "Free appointment times",
          parameters: [
            { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Start of the window (default: now)." },
            { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "End of the window (default: 14 days; at most 62)." },
          ],
          responses: { "200": { description: `Open slots in ${ch.timezone}.` }, "404": { description: "Booking is paused or the link is wrong." } },
        },
      },
      "/bookings": {
        post: {
          operationId: "requestBooking",
          summary: "Ask for a time (waits for the business's approval)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["slotId", "requesterKind", "disclosureAck", "customerName", "customerEmail"],
                  properties: {
                    slotId: { type: "string", description: "From /availability." },
                    requesterKind: { type: "string", enum: ["ai_agent", "person"] },
                    agentName: { type: "string", maxLength: 200, description: "Required for ai_agent: who is asking, e.g. the assistant's product name." },
                    agentProvider: { type: "string", maxLength: 200 },
                    disclosureAck: { type: "boolean", const: true, description: "The customer saw the disclosure." },
                    customerName: { type: "string", maxLength: 200 },
                    customerEmail: { type: "string", format: "email" },
                    customerPhone: { type: "string", maxLength: 40 },
                    notes: { type: "string", maxLength: 2000 },
                    clientRef: { type: "string", maxLength: 100, description: "Your idempotency key: resending the same value doesn't create a second request." },
                  },
                },
              },
            },
          },
          responses: {
            "202": { description: "Received and waiting for approval. Not confirmed yet.", content: { "application/json": { schema: { type: "object", properties: { bookingId: { type: "string" }, status: { type: "string" }, approvalRequired: { type: "boolean", const: true } } } } } },
            "400": { description: "Missing or invalid fields." },
            "409": { description: "That slot is full." },
            "429": { description: "Too many requests; slow down." },
          },
        },
      },
    },
  };
  return NextResponse.json(doc, { headers: { "cache-control": "no-store" } });
}
