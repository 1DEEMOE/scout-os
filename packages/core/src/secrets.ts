import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope for integration credentials (OAuth tokens, API keys) and bank details.
 *
 * AES-256-GCM with keys from the environment, never stored in the database.
 * The additional authenticated data binds each ciphertext to its tenant and
 * row, so a ciphertext copied onto another tenant's row fails to decrypt.
 *
 * Key rotation (docs/plans/secrets-rotation-runbook.md): each ciphertext starts
 * with the id of the key that sealed it. New values always use the current key;
 * old values still open with the previous key until `rotateStoredSecrets`
 * re-seals them, after which the previous key can be removed.
 *   WOS_SECRETS_KEY / WOS_SECRETS_KEY_ID                    current (id defaults to "v1")
 *   WOS_SECRETS_KEY_PREVIOUS / WOS_SECRETS_KEY_PREVIOUS_ID  only during a rotation
 */
export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function parseKey(raw: string | undefined, name: string): Buffer {
  if (!raw) throw new SecretsError(`${name} is not set; integrations can't store credentials`);
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new SecretsError(`${name} must be 32 bytes, base64-encoded`);
  return k;
}

/** The current key id: what new ciphertexts are sealed with. */
export function currentSecretKeyId(): string {
  const id = process.env.WOS_SECRETS_KEY_ID || "v1";
  if (!ID_RE.test(id)) throw new SecretsError("WOS_SECRETS_KEY_ID must be 1-32 letters, digits, _ or -");
  return id;
}

function keyRing(): Map<string, Buffer> {
  const ring = new Map<string, Buffer>([[currentSecretKeyId(), parseKey(process.env.WOS_SECRETS_KEY, "WOS_SECRETS_KEY")]]);
  if (process.env.WOS_SECRETS_KEY_PREVIOUS) {
    const prevId = process.env.WOS_SECRETS_KEY_PREVIOUS_ID;
    if (!prevId || !ID_RE.test(prevId)) throw new SecretsError("Set WOS_SECRETS_KEY_PREVIOUS_ID to the id the previous key used (e.g. v1)");
    if (ring.has(prevId)) throw new SecretsError("The previous and current secrets keys need different ids");
    ring.set(prevId, parseKey(process.env.WOS_SECRETS_KEY_PREVIOUS, "WOS_SECRETS_KEY_PREVIOUS"));
  }
  return ring;
}

const aad = (tenantId: string, connectionId: string) => Buffer.from(`${tenantId}:${connectionId}`);

export function encryptSecret(plaintext: unknown, binding: { tenantId: string; connectionId: string }): string {
  const kid = currentSecretKeyId();
  const key = keyRing().get(kid)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding.tenantId, binding.connectionId));
  const body = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  return [kid, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecret<T>(blob: string, binding: { tenantId: string; connectionId: string }): T {
  const [kid, iv, tag, body] = blob.split(".");
  if (!kid || !iv || !tag || !body) throw new SecretsError("Unrecognised secret format");
  const key = keyRing().get(kid);
  if (!key) throw new SecretsError(`This credential was sealed with key "${kid}", which isn't loaded. Set it as WOS_SECRETS_KEY_PREVIOUS until rotation finishes.`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(aad(binding.tenantId, binding.connectionId));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    throw new SecretsError("Credential could not be decrypted (wrong key, tampered, or bound to another connection)");
  }
}

/** The key id a ciphertext was sealed with (no decryption). */
export function secretKeyIdOf(blob: string): string | null {
  const kid = blob.split(".")[0];
  return kid && ID_RE.test(kid) ? kid : null;
}

/** Re-seals one ciphertext under the current key, keeping its binding. Returns null if already current. */
export function resealSecret(blob: string, binding: { tenantId: string; connectionId: string }): string | null {
  if (secretKeyIdOf(blob) === currentSecretKeyId()) return null;
  return encryptSecret(decryptSecret<unknown>(blob, binding), binding);
}
