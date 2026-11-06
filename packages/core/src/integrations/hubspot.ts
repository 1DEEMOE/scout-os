import { Client } from "@hubspot/api-client";
import type { CrmContactInput, CrmProvider } from "./crm";

/**
 * HubSpot adapter using a private-app access token. UNVERIFIED against a live
 * portal: no HubSpot account was available in any build session. Request
 * shapes are unit-tested with a fake client.
 *
 * Portal setup (runbook): a deal property `wos_idempotency_key` (single-line
 * text) and a note property of the same name, so retried writes can be found.
 * Required scopes: crm.objects.contacts.read/write, crm.objects.deals.read/write.
 */
export const IDEMPOTENCY_PROPERTY = "wos_idempotency_key";

type Hs = Pick<Client, "crm">;

export class HubSpotProvider implements CrmProvider {
  readonly name = "hubspot" as const;
  readonly mock = false;
  private readonly hs: Hs;

  constructor(accessToken: string, client?: Hs, private readonly pipeline = "default") {
    this.hs = client ?? new Client({ accessToken, numberOfApiCallRetries: 2 });
  }

  async upsertContact(c: CrmContactInput): Promise<{ externalId: string }> {
    const email = c.email.toLowerCase();
    const props: Record<string, string> = { email };
    if (c.name) {
      const [first, ...rest] = c.name.trim().split(/\s+/);
      props.firstname = first ?? "";
      if (rest.length) props.lastname = rest.join(" ");
    }
    if (c.phone) props.phone = c.phone;
    if (c.company) props.company = c.company;
    const found = await this.hs.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ" as never, value: email }] }],
      properties: ["email"],
      limit: 1,
      after: undefined as never,
      sorts: [],
    });
    const existing = found.results[0]?.id;
    if (existing) {
      await this.hs.crm.contacts.basicApi.update(existing, { properties: props });
      return { externalId: existing };
    }
    const created = await this.hs.crm.contacts.basicApi.create({ properties: props, associations: [] });
    return { externalId: created.id };
  }

  async createDeal(d: { name: string; stage: string; contactExternalId?: string }, key: string): Promise<{ externalId: string }> {
    const found = await this.findDealByKey(key);
    if (found) return found;
    const created = await this.hs.crm.deals.basicApi.create({
      properties: { dealname: d.name, dealstage: d.stage, pipeline: this.pipeline, [IDEMPOTENCY_PROPERTY]: key },
      associations: d.contactExternalId
        ? [{ to: { id: d.contactExternalId }, types: [{ associationCategory: "HUBSPOT_DEFINED" as never, associationTypeId: 3 }] }]
        : [],
    });
    return { externalId: created.id };
  }

  async findDealByKey(key: string): Promise<{ externalId: string } | undefined> {
    const r = await this.hs.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: IDEMPOTENCY_PROPERTY, operator: "EQ" as never, value: key }] }],
      properties: [IDEMPOTENCY_PROPERTY],
      limit: 1,
      after: undefined as never,
      sorts: [],
    });
    const id = r.results[0]?.id;
    return id ? { externalId: id } : undefined;
  }

  async updateDeal(externalId: string, f: { stage?: string; amountCents?: number }): Promise<void> {
    const properties: Record<string, string> = {};
    if (f.stage) properties.dealstage = f.stage;
    if (f.amountCents !== undefined) properties.amount = (f.amountCents / 100).toFixed(2);
    await this.hs.crm.deals.basicApi.update(externalId, { properties });
  }

  async addNote(contactExternalId: string, body: string, key: string): Promise<{ externalId: string }> {
    const found = await this.hs.crm.objects.notes.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: IDEMPOTENCY_PROPERTY, operator: "EQ" as never, value: key }] }],
      properties: [IDEMPOTENCY_PROPERTY],
      limit: 1,
      after: undefined as never,
      sorts: [],
    });
    if (found.results[0]) return { externalId: found.results[0].id };
    const created = await this.hs.crm.objects.notes.basicApi.create({
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString(), [IDEMPOTENCY_PROPERTY]: key },
      // 202 = note to contact (HubSpot-defined association type).
      associations: [{ to: { id: contactExternalId }, types: [{ associationCategory: "HUBSPOT_DEFINED" as never, associationTypeId: 202 }] }],
    });
    return { externalId: created.id };
  }
}
