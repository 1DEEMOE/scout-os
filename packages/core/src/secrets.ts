import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope for integration credentials (OAuth tokens, API keys).
 *
 * AES-256-GCM with a key from WOS_SECRETS_KEY (32 bytes, base64), never stored
 * in the database. The additional authenticated data binds each ciphertext to
 * its tenant and connection, so a ciphertext copied onto another tenant's row
 * fails to decrypt.
 */
export const SECRET_KEY_ID = "v1";

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

function key(): Buffer {
  const raw = process.env.WOS_SECRETS_KEY;
  if (!raw) throw new SecretsError("WOS_SECRETS_KEY is not set; integrations can't store credentials");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new SecretsError("WOS_SECRETS_KEY must be 32 bytes, base64-encoded");
  return k;
}

const aad = (tenantId: string, connectionId: string) => Buffer.from(`${tenantId}:${connectionId}`);

export function encryptSecret(plaintext: unknown, binding: { tenantId: string; connectionId: string }): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(binding.tenantId, binding.connectionId));
  const body = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  return [SECRET_KEY_ID, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecret<T>(blob: string, binding: { tenantId: string; connectionId: string }): T {
  const [kid, iv, tag, body] = blob.split(".");
  if (kid !== SECRET_KEY_ID || !iv || !tag || !body) throw new SecretsError("Unrecognised secret format");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAAD(aad(binding.tenantId, binding.connectionId));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    throw new SecretsError("Credential could not be decrypted (wrong key, tampered, or bound to another connection)");
  }
}
