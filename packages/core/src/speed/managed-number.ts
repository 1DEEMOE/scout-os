import { normalizePhone } from "./sms";

/**
 * Managed business numbers: the platform buys and wires a Twilio number for a workspace so the
 * owner never opens the Twilio console. Buying a number spends money, so it is a Tier 3 action:
 * it needs a named human approval and is never triggered automatically.
 *
 * UNVERIFIED against live Twilio: the live adapter is tested only with an injected fake fetch.
 * NOT yet wired into the app: no route, no persistence adapter, no call from enable/rotate.
 */

export interface WebhookUrls { voiceUrl: string; voiceFallbackUrl?: string; smsUrl: string }
export interface AvailableNumber { phone: string; locality?: string; region?: string }
export interface OwnedNumber { sid: string; phone: string }

export interface NumberProvisioner {
  /** True for the labelled MOCK: nothing is bought. */
  readonly mock: boolean;
  search(opts: { areaCode: string; limit: number }): Promise<AvailableNumber[]>;
  findOwned(phone: string): Promise<OwnedNumber | null>;
  buy(req: { phone: string; friendlyName: string; urls: WebhookUrls }): Promise<OwnedNumber>;
  updateWebhooks(sid: string, urls: WebhookUrls): Promise<void>;
  release(sid: string): Promise<void>;
}

export type A2pStatus = "not_started" | "pending" | "approved" | "rejected";
export interface ManagedNumberRecord {
  tenantId: string;
  phone: string;
  sid?: string;
  /** "reserving" is written BEFORE the purchase so a crash after buying can be reconciled. */
  status: "reserving" | "active" | "releasing" | "released";
  a2p: A2pStatus;
  mock: boolean;
  updatedAt: string;
}

export interface ManagedNumberStore {
  get(tenantId: string): Promise<ManagedNumberRecord | null>;
  getByPhone(phone: string): Promise<ManagedNumberRecord | null>;
  put(record: ManagedNumberRecord): Promise<void>;
}

export interface Approval { approvedBy: string; tier: 3 | 4 }

export class ManagedNumberError extends Error {
  constructor(readonly code: "approval_required" | "invalid_input" | "conflict" | "not_found" | "provider_error", message: string) { super(message); }
}

const err = (code: ManagedNumberError["code"], m: string) => new ManagedNumberError(code, m);

export function requireApproval(a: Approval | undefined): asserts a is Approval {
  if (!a || a.tier < 3 || !a.approvedBy.trim() || /^system:/i.test(a.approvedBy)) {
    throw err("approval_required", "Buying or releasing a phone number needs a named human approval (Tier 3). It is never automatic.");
  }
}

export function validAreaCode(code: string): boolean { return /^[2-9]\d{2}$/.test(code); }

/** US numbers only: international numbers carry different costs and regulations. */
export function usNumber(raw: string): string {
  const p = normalizePhone(raw);
  if (!p || !/^\+1[2-9]\d{9}$/.test(p)) throw err("invalid_input", "Only US phone numbers can be provisioned.");
  return p;
}

export function buildWebhookUrls(publicBase: string, publicToken: string): WebhookUrls {
  let u: URL;
  try { u = new URL(publicBase); } catch { throw err("invalid_input", "Public base URL is not a valid URL."); }
  if (u.protocol !== "https:") throw err("invalid_input", "Twilio webhooks must use https.");
  if (!/^[A-Za-z0-9_-]{16,}$/.test(publicToken)) throw err("invalid_input", "Front-desk token is missing or malformed.");
  const base = `${u.protocol}//${u.host}/api/front-desk/${encodeURIComponent(publicToken)}`;
  return { voiceUrl: `${base}/voice`, smsUrl: `${base}/sms` };
}

/** What the owner is asked to approve. Nothing is bought by calling this. */
export interface ProvisionProposal {
  approvalTier: 3;
  status: "proposal_not_purchased";
  options: AvailableNumber[];
  mock: boolean;
  warnings: string[];
}

export async function proposeNumbers(port: NumberProvisioner, areaCode: string, limit = 5): Promise<ProvisionProposal> {
  if (!validAreaCode(areaCode)) throw err("invalid_input", "Enter a 3-digit US area code.");
  const options = await port.search({ areaCode, limit: Math.min(Math.max(limit, 1), 10) });
  return {
    approvalTier: 3, status: "proposal_not_purchased", options, mock: port.mock,
    warnings: [
      "Buying a number adds a recurring cost to the platform account. Who pays, and the price, are owner decisions.",
      "Calls can be answered right away. Texting from a new US local number is generally blocked or filtered by carriers until A2P 10DLC registration is approved (or a toll-free number is verified). Text-back stays OFF until you record approval. Verify current carrier rules.",
      ...(port.mock ? ["MOCK: no real number is bought."] : []),
    ],
  };
}

const now = () => new Date().toISOString();

export async function provisionManagedNumber(i: {
  port: NumberProvisioner; store: ManagedNumberStore; tenantId: string; phone: string; businessName: string;
  publicBase: string; publicToken: string; approval: Approval | undefined;
}): Promise<ManagedNumberRecord> {
  requireApproval(i.approval);
  const phone = usNumber(i.phone);
  const urls = buildWebhookUrls(i.publicBase, i.publicToken);

  const existing = await i.store.get(i.tenantId);
  if (existing && (existing.status === "active" || existing.status === "reserving") && existing.phone !== phone) {
    throw err("conflict", "This workspace already has a managed number. Release it before getting another.");
  }
  if (existing?.status === "active") return existing; // idempotent
  const holder = await i.store.getByPhone(phone);
  if (holder && holder.tenantId !== i.tenantId && holder.status !== "released") {
    throw err("conflict", "That number already belongs to another workspace.");
  }

  // Intent first: if we crash after buying, the next attempt finds this and reconciles instead of buying twice.
  const reserving: ManagedNumberRecord = { tenantId: i.tenantId, phone, status: "reserving", a2p: "not_started", mock: i.port.mock, updatedAt: now() };
  await i.store.put(reserving);

  let owned = await i.port.findOwned(phone);
  if (owned) await i.port.updateWebhooks(owned.sid, urls); // already ours (earlier crash): just make sure it points here
  else owned = await i.port.buy({ phone, friendlyName: `ascend:${i.businessName.slice(0, 40)}`, urls });

  const active: ManagedNumberRecord = { ...reserving, sid: owned.sid, status: "active", updatedAt: now() };
  await i.store.put(active);
  return active;
}

/** Call after enabling or rotating the front-desk link, or voice and SMS silently stop working. */
export async function repointManagedNumber(i: { port: NumberProvisioner; store: ManagedNumberStore; tenantId: string; publicBase: string; publicToken: string }): Promise<void> {
  const rec = await i.store.get(i.tenantId);
  if (!rec || rec.status !== "active" || !rec.sid) throw err("not_found", "No active managed number for this workspace.");
  await i.port.updateWebhooks(rec.sid, buildWebhookUrls(i.publicBase, i.publicToken));
}

export async function releaseManagedNumber(i: { port: NumberProvisioner; store: ManagedNumberStore; tenantId: string; approval: Approval | undefined }): Promise<ManagedNumberRecord> {
  requireApproval(i.approval);
  const rec = await i.store.get(i.tenantId);
  if (!rec || rec.status === "reserving") throw err("not_found", "No active managed number for this workspace.");
  if (rec.status === "released") return rec; // idempotent
  await i.store.put({ ...rec, status: "releasing", updatedAt: now() });
  if (rec.sid) await i.port.release(rec.sid);
  const done: ManagedNumberRecord = { ...rec, status: "released", updatedAt: now() };
  await i.store.put(done);
  return done;
}

/** The owner records the outcome of carrier registration, done in Twilio's process, not here. */
export async function recordA2pStatus(store: ManagedNumberStore, tenantId: string, status: A2pStatus): Promise<ManagedNumberRecord> {
  const rec = await store.get(tenantId);
  if (!rec || rec.status !== "active") throw err("not_found", "No active managed number for this workspace.");
  const next = { ...rec, a2p: status, updatedAt: now() };
  await store.put(next);
  return next;
}

export function channelReadiness(rec: ManagedNumberRecord | null): { voice: boolean; textBack: boolean; reason?: string } {
  if (!rec || rec.status !== "active") return { voice: false, textBack: false, reason: "No active managed number." };
  if (rec.a2p !== "approved") return { voice: true, textBack: false, reason: `Text-back is off until carrier registration is approved (now: ${rec.a2p}).` };
  return { voice: true, textBack: true };
}

export class InMemoryManagedNumberStore implements ManagedNumberStore {
  readonly rows = new Map<string, ManagedNumberRecord>();
  async get(t: string) { return this.rows.get(t) ?? null; }
  async getByPhone(p: string) { return [...this.rows.values()].find((r) => r.phone === p) ?? null; }
  async put(r: ManagedNumberRecord) { this.rows.set(r.tenantId, { ...r }); }
}

/** MOCK provisioner: deterministic fictional numbers, nothing bought. */
export class MockNumberProvisioner implements NumberProvisioner {
  readonly mock = true;
  readonly owned = new Map<string, { sid: string; urls: WebhookUrls }>();
  buys = 0;
  async search({ areaCode, limit }: { areaCode: string; limit: number }) {
    return Array.from({ length: limit }, (_, i) => ({ phone: `+1${areaCode}555010${i}`, locality: "MOCK", region: "MOCK" }));
  }
  async findOwned(phone: string) { const o = this.owned.get(phone); return o ? { sid: o.sid, phone } : null; }
  async buy({ phone, urls }: { phone: string; urls: WebhookUrls }) { this.buys++; const sid = `PN_mock_${this.owned.size + 1}`; this.owned.set(phone, { sid, urls }); return { sid, phone }; }
  async updateWebhooks(sid: string, urls: WebhookUrls) { for (const [p, o] of this.owned) if (o.sid === sid) this.owned.set(p, { sid, urls }); }
  async release(sid: string) { for (const [p, o] of this.owned) if (o.sid === sid) this.owned.delete(p); }
}

/* ---------------- Live Twilio REST adapter ---------------- */

type FetchInit = { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal };
export type TwilioFetch = (url: string, init: FetchInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class TwilioNumberProvisioner implements NumberProvisioner {
  readonly mock = false;
  constructor(private readonly accountSid: string, private readonly authToken: string, private readonly doFetch: TwilioFetch = (u, i) => fetch(u, i) as unknown as ReturnType<TwilioFetch>) {}

  private get base() { return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`; }
  private async call(method: string, path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Status and Twilio's numeric code only: error bodies can quote phone numbers (PII).
    if (!res.ok) throw err("provider_error", `twilio_failed:${method}:${res.status}${body.code ? `:${String(body.code)}` : ""}`);
    return body;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, doFetch?: TwilioFetch): TwilioNumberProvisioner | null {
    const sid = env.TWILIO_ACCOUNT_SID?.trim(), token = env.TWILIO_AUTH_TOKEN?.trim();
    // Spending money needs an explicit opt-in on top of credentials.
    if (!sid || !token || env.WOS_MANAGED_NUMBERS !== "1") return null;
    return new TwilioNumberProvisioner(sid, token, doFetch);
  }

  async search({ areaCode, limit }: { areaCode: string; limit: number }) {
    const b = await this.call("GET", `/AvailablePhoneNumbers/US/Local.json?${new URLSearchParams({ AreaCode: areaCode, VoiceEnabled: "true", SmsEnabled: "true", PageSize: String(limit) })}`);
    const list = (b.available_phone_numbers as { phone_number: string; locality?: string; region?: string }[] | undefined) ?? [];
    return list.map((n) => ({ phone: n.phone_number, locality: n.locality, region: n.region }));
  }
  async findOwned(phone: string) {
    const b = await this.call("GET", `/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: phone })}`);
    const n = (b.incoming_phone_numbers as { sid: string; phone_number: string }[] | undefined)?.[0];
    return n ? { sid: n.sid, phone: n.phone_number } : null;
  }
  private form(urls: WebhookUrls): Record<string, string> {
    return { VoiceUrl: urls.voiceUrl, VoiceMethod: "POST", SmsUrl: urls.smsUrl, SmsMethod: "POST", ...(urls.voiceFallbackUrl ? { VoiceFallbackUrl: urls.voiceFallbackUrl } : {}) };
  }
  async buy({ phone, friendlyName, urls }: { phone: string; friendlyName: string; urls: WebhookUrls }) {
    const b = await this.call("POST", "/IncomingPhoneNumbers.json", { PhoneNumber: phone, FriendlyName: friendlyName, ...this.form(urls) });
    if (typeof b.sid !== "string") throw err("provider_error", "twilio_failed:POST:no_sid");
    return { sid: b.sid, phone };
  }
  async updateWebhooks(sid: string, urls: WebhookUrls) { await this.call("POST", `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, this.form(urls)); }
  async release(sid: string) { await this.call("DELETE", `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`); }
}

/** Mock in mock mode; live only with credentials AND WOS_MANAGED_NUMBERS=1; otherwise the feature is off (null). */
export function numberProvisionerFromEnv(env: NodeJS.ProcessEnv = process.env): NumberProvisioner | null {
  if (env.WOS_MOCK_MODE === "1") return new MockNumberProvisioner();
  return TwilioNumberProvisioner.fromEnv(env);
}
