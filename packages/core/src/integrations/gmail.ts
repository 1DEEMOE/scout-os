import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { buildRfc822, type InboundMessage, type MailProvider, type OutboundDraft } from "./mail";

/**
 * Gmail adapter. UNVERIFIED against a live mailbox: no Google OAuth client has
 * been available in any build session. Request shapes are covered by unit
 * tests with a fake Gmail client; run the M3 acceptance against a test Google
 * account before relying on it.
 *
 * Scopes: gmail.readonly (sync) and gmail.compose (drafts, send). Both are
 * restricted scopes; public launch needs Google's verification (ip-flags #5).
 */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];

export interface GoogleTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
}

export function googleOAuthClient(redirectUri?: string): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google integration is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Plain-text body: the first text/plain part, else the snippet. */
function plainText(part: gmail_v1.Schema$MessagePart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  return undefined;
}

/** Exchanges an OAuth code and reads the mailbox address. UNVERIFIED (see above). */
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{ tokens: GoogleTokens; address: string; scopes: string[] }> {
  const auth = googleOAuthClient(redirectUri);
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  const profile = await gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
  const address = profile.data.emailAddress;
  if (!address) throw new Error("Google did not return the mailbox address");
  return { tokens, address, scopes: (tokens.scope ?? "").split(" ").filter(Boolean) };
}

export function googleAuthUrl(redirectUri: string, state: string): string {
  return googleOAuthClient(redirectUri).generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES, state, include_granted_scopes: true });
}

export class GmailProvider implements MailProvider {
  readonly name = "gmail";
  readonly mock = false;
  private readonly api: gmail_v1.Gmail;

  constructor(
    auth: OAuth2Client,
    private readonly address: string,
    api?: gmail_v1.Gmail,
  ) {
    this.api = api ?? gmail({ version: "v1", auth });
  }

  /** Creates a provider from stored tokens. `onTokens` persists refreshed tokens. */
  static fromTokens(tokens: GoogleTokens, address: string, onTokens: (t: Credentials) => Promise<void>): GmailProvider {
    const auth = googleOAuthClient();
    auth.setCredentials(tokens);
    auth.on("tokens", (t) => void onTokens(t));
    return new GmailProvider(auth, address);
  }

  async listRecent(opts: { cursor?: string | null; max?: number }): Promise<{ messages: InboundMessage[]; cursor: string | null }> {
    // Cursor is an epoch-seconds watermark; Gmail's `after:` search is second-granular.
    const after = opts.cursor ? `after:${opts.cursor}` : "newer_than:7d";
    const list = await this.api.users.messages.list({ userId: "me", q: `${after} -in:drafts`, maxResults: opts.max ?? 50 });
    const out: InboundMessage[] = [];
    let newest = opts.cursor ? Number(opts.cursor) : 0;
    for (const ref of list.data.messages ?? []) {
      const { data: m } = await this.api.users.messages.get({ userId: "me", id: ref.id!, format: "full" });
      const sentAt = new Date(Number(m.internalDate ?? Date.now()));
      newest = Math.max(newest, Math.floor(sentAt.getTime() / 1000));
      const from = header(m, "From");
      out.push({
        externalId: m.id!,
        threadId: m.threadId!,
        rfc822MessageId: header(m, "Message-ID") || undefined,
        from,
        to: header(m, "To").split(",").map((s) => s.trim()).filter(Boolean),
        subject: header(m, "Subject"),
        body: (plainText(m.payload) ?? m.snippet ?? "").slice(0, 100000),
        sentAt,
        direction: (m.labelIds ?? []).includes("SENT") ? "outbound" : "inbound",
      });
    }
    return { messages: out, cursor: newest ? String(newest) : (opts.cursor ?? null) };
  }

  async createDraft(d: OutboundDraft): Promise<{ draftId: string }> {
    const existing = await this.findDraft(d.messageId);
    if (existing) return existing;
    const res = await this.api.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: buildRfc822({ ...d, from: this.address }), threadId: d.threadId } },
    });
    return { draftId: res.data.id! };
  }

  async updateDraft(draftId: string, d: OutboundDraft): Promise<{ draftId: string }> {
    const res = await this.api.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: { id: draftId, message: { raw: buildRfc822({ ...d, from: this.address }), threadId: d.threadId } },
    });
    return { draftId: res.data.id ?? draftId };
  }

  async findDraft(messageId: string): Promise<{ draftId: string } | undefined> {
    const res = await this.api.users.drafts.list({ userId: "me", q: `rfc822msgid:${messageId}`, maxResults: 1 });
    const id = res.data.drafts?.[0]?.id;
    return id ? { draftId: id } : undefined;
  }

  async sendDraft(draftId: string): Promise<{ externalId: string }> {
    const res = await this.api.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    return { externalId: res.data.id! };
  }

  async findSent(messageId: string): Promise<{ externalId: string } | undefined> {
    const res = await this.api.users.messages.list({ userId: "me", q: `in:sent rfc822msgid:${messageId}`, maxResults: 1 });
    const id = res.data.messages?.[0]?.id;
    return id ? { externalId: id } : undefined;
  }
}
