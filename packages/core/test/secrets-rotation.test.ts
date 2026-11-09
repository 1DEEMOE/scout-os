import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@wos/db";
import {
  applyPaymentDestinationChange,
  createOrg,
  currentSecretKeyId,
  decryptSecret,
  encryptSecret,
  openPaymentSecret,
  readSecret,
  rotateStoredSecrets,
  secretKeyIdOf,
  upsertConnection,
} from "../src/index";
import { adminQuery, resetDb, seedUser } from "../../db/test/helpers";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const saved = { ...process.env };
const useKeys = (current: string, id: string, previous?: { key: string; id: string }) => {
  process.env.WOS_SECRETS_KEY = current;
  process.env.WOS_SECRETS_KEY_ID = id;
  if (previous) {
    process.env.WOS_SECRETS_KEY_PREVIOUS = previous.key;
    process.env.WOS_SECRETS_KEY_PREVIOUS_ID = previous.id;
  } else {
    delete process.env.WOS_SECRETS_KEY_PREVIOUS;
    delete process.env.WOS_SECRETS_KEY_PREVIOUS_ID;
  }
};
afterEach(() => {
  for (const k of ["WOS_SECRETS_KEY", "WOS_SECRETS_KEY_ID", "WOS_SECRETS_KEY_PREVIOUS", "WOS_SECRETS_KEY_PREVIOUS_ID"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await closePool();
});

describe("secrets key ring", () => {
  const b = { tenantId: "t1", connectionId: "c1" };
  it("seals with the current key; opens old values with the previous key during a rotation", () => {
    useKeys(KEY_A, "v1");
    const old = encryptSecret({ token: "abc" }, b);
    expect(secretKeyIdOf(old)).toBe("v1");
    useKeys(KEY_B, "v2", { key: KEY_A, id: "v1" });
    expect(currentSecretKeyId()).toBe("v2");
    expect(decryptSecret(old, b)).toEqual({ token: "abc" });
    expect(secretKeyIdOf(encryptSecret({ token: "new" }, b))).toBe("v2");
    useKeys(KEY_B, "v2"); // previous removed too early
    expect(() => decryptSecret(old, b)).toThrow(/sealed with key "v1", which isn't loaded/);
  });
  it("refuses unsafe key settings", () => {
    useKeys(KEY_A, "v1", { key: KEY_B, id: "v1" });
    expect(() => encryptSecret({}, b)).toThrow(/different ids/);
    useKeys(KEY_A, "bad id!");
    expect(() => encryptSecret({}, b)).toThrow(/WOS_SECRETS_KEY_ID/);
    process.env.WOS_SECRETS_KEY_ID = "v1";
    process.env.WOS_SECRETS_KEY_PREVIOUS = KEY_B;
    delete process.env.WOS_SECRETS_KEY_PREVIOUS_ID;
    expect(() => encryptSecret({}, b)).toThrow(/WOS_SECRETS_KEY_PREVIOUS_ID/);
  });
  it("a value copied onto another row still won't open", () => {
    useKeys(KEY_A, "v1");
    const v = encryptSecret({ x: 1 }, b);
    expect(() => decryptSecret(v, { tenantId: "t1", connectionId: "c2" })).toThrow(/could not be decrypted/);
  });
});

describe("rotating stored secrets", () => {
  let orgId: string;
  beforeEach(async () => {
    await resetDb();
    await seedUser("owner", "owner@example.test");
    useKeys(KEY_A, "v1");
    orgId = (await createOrg({ actorUserId: "owner", name: "Rotate Co" })).orgId;
  });

  it("bank details saved directly can be read back (regression: they were bound to a throwaway id)", async () => {
    const r = await withTenant(orgId, (tx) =>
      applyPaymentDestinationChange(tx, { tenantId: orgId, actorId: "owner", kind: "vendor", contactId: null, label: "Acme", accountNumber: "123456789012", routingNumber: "021000021" }),
    );
    const [row] = await adminQuery<{ ciphertext: string }>("SELECT ciphertext FROM payment_destinations WHERE id = $1", [r.destinationId]);
    expect(openPaymentSecret(row!.ciphertext, { tenantId: orgId, bindingId: r.destinationId })).toMatchObject({ accountNumber: "123456789012" });
  });

  it("re-seals every table under the new key, keeps values readable, audits per workspace, and is safe to re-run", async () => {
    const conn = await withTenant(orgId, (tx) => upsertConnection(tx, { tenantId: orgId, provider: "google", accountLabel: "office@rotate.test", scopes: [], secret: { refresh_token: "r-123" }, createdBy: "owner" }));
    const dest = await withTenant(orgId, (tx) =>
      applyPaymentDestinationChange(tx, { tenantId: orgId, actorId: "owner", kind: "vendor", contactId: null, label: "Acme", accountNumber: "123456789012" }),
    );
    // A row nobody can open (e.g. sealed with a key that was lost) must be reported and left alone.
    const ghost = await withTenant(orgId, (tx) =>
      applyPaymentDestinationChange(tx, { tenantId: orgId, actorId: "owner", kind: "vendor", contactId: null, label: "Lost", accountNumber: "999988887777" }),
    );
    await adminQuery("UPDATE payment_destinations SET ciphertext = 'v0.AAAA.AAAA.AAAA' WHERE id = $1", [ghost.destinationId]);

    useKeys(KEY_B, "v2", { key: KEY_A, id: "v1" });
    await expect(rotateStoredSecrets({ confirmKeyId: "v1" })).rejects.toThrow(/--confirm v2/);

    const dry = await rotateStoredSecrets({ confirmKeyId: "v2", dryRun: true });
    expect(dry.tables.find((t) => t.table === "integration_connections")!.resealed).toBe(1);
    expect((await adminQuery<{ k: string }>("SELECT split_part(secret_ciphertext, '.', 1) AS k FROM integration_connections"))[0]!.k).toBe("v1"); // dry run changed nothing

    const run = await rotateStoredSecrets({ confirmKeyId: "v2" });
    const by = Object.fromEntries(run.tables.map((t) => [t.table, t]));
    expect(by.integration_connections).toMatchObject({ total: 1, resealed: 1, unreadable: [] });
    expect(by.payment_destinations).toMatchObject({ resealed: 1 });
    expect(by.payment_destinations!.unreadable).toEqual([{ tenantId: orgId, id: ghost.destinationId, keyId: "v0" }]);
    expect((await adminQuery<{ c: string }>("SELECT ciphertext AS c FROM payment_destinations WHERE id = $1", [ghost.destinationId]))[0]!.c).toBe("v0.AAAA.AAAA.AAAA");

    // The old key can now go: everything still opens.
    useKeys(KEY_B, "v2");
    const [c] = await adminQuery<{ tenant_id: string; id: string; secret_ciphertext: string; secret_ref: string }>("SELECT tenant_id, id, secret_ciphertext, secret_ref FROM integration_connections WHERE id = $1", [conn.id]);
    expect(c!.secret_ref).toBe("v2");
    expect(readSecret({ tenantId: c!.tenant_id, id: c!.id, secretCiphertext: c!.secret_ciphertext })).toEqual({ refresh_token: "r-123" });
    const [d] = await adminQuery<{ ciphertext: string }>("SELECT ciphertext FROM payment_destinations WHERE id = $1", [dest.destinationId]);
    expect(openPaymentSecret(d!.ciphertext, { tenantId: orgId, bindingId: dest.destinationId })).toMatchObject({ accountNumber: "123456789012" });
    const audit = await adminQuery<{ tier: number; actor_id: string }>("SELECT tier, actor_id FROM audit_events WHERE tenant_id = $1 AND action = 'secrets.rotate'", [orgId]);
    expect(audit).toEqual([{ tier: 4, actor_id: "secrets-rotation" }]);

    // Re-running is a no-op.
    useKeys(KEY_B, "v2", { key: KEY_A, id: "v1" });
    const again = await rotateStoredSecrets({ confirmKeyId: "v2" });
    expect(again.tables.reduce((n, t) => n + t.resealed, 0)).toBe(0);
  });
});
