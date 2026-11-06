export interface CrmContactInput {
  email: string;
  name?: string;
  phone?: string;
  company?: string;
}

/** What the sales agent needs from a CRM. HubSpot is one implementation. */
export interface CrmProvider {
  readonly name: "hubspot" | "fake";
  readonly mock: boolean;
  /** Email is the natural key, so this is idempotent by itself. */
  upsertContact(c: CrmContactInput): Promise<{ externalId: string }>;
  createDeal(d: { name: string; stage: string; contactExternalId?: string }, idempotencyKey: string): Promise<{ externalId: string }>;
  findDealByKey(idempotencyKey: string): Promise<{ externalId: string } | undefined>;
  updateDeal(externalId: string, fields: { stage?: string; amountCents?: number }): Promise<void>;
  addNote(contactExternalId: string, body: string, idempotencyKey: string): Promise<{ externalId: string }>;
}

/** MOCK CRM for tests and demos. In memory; nothing leaves the process. */
export class FakeCrmProvider implements CrmProvider {
  readonly name = "fake" as const;
  readonly mock = true;
  contacts = new Map<string, CrmContactInput & { externalId: string }>();
  deals = new Map<string, { name: string; stage: string; amountCents?: number; contactExternalId?: string; key: string }>();
  notes = new Map<string, { contactExternalId: string; body: string }>();
  writes = 0;

  async upsertContact(c: CrmContactInput) {
    this.writes++;
    const key = c.email.toLowerCase();
    const existing = this.contacts.get(key);
    const externalId = existing?.externalId ?? `fc_${this.contacts.size + 1}`;
    this.contacts.set(key, { ...existing, ...c, email: key, externalId });
    return { externalId };
  }

  async createDeal(d: { name: string; stage: string; contactExternalId?: string }, key: string) {
    this.writes++;
    const found = await this.findDealByKey(key);
    if (found) return found;
    const externalId = `fd_${this.deals.size + 1}`;
    this.deals.set(externalId, { ...d, key });
    return { externalId };
  }

  async findDealByKey(key: string) {
    for (const [externalId, d] of this.deals) if (d.key === key) return { externalId };
    return undefined;
  }

  async updateDeal(externalId: string, f: { stage?: string; amountCents?: number }) {
    this.writes++;
    const d = this.deals.get(externalId);
    if (!d) throw new Error(`MOCK: deal ${externalId} not found`);
    Object.assign(d, f);
  }

  async addNote(contactExternalId: string, body: string, key: string) {
    this.writes++;
    if (!this.notes.has(key)) this.notes.set(key, { contactExternalId, body });
    return { externalId: `fn_${key.slice(-8)}` };
  }
}
