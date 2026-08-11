import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../env.js";

// Authenticated encryption (AES-256-GCM) for provider connection material at rest
// (provider connection ids, access/refresh tokens). The key lives only in the
// environment (OPEN_BANKING_DATA_KEY). Ciphertext is stored as a compact string:
//   v1.<iv_b64>.<tag_b64>.<ciphertext_b64>
// Never log plaintext, keys, or tokens.

const PREFIX = "v1";

function loadKey(): Buffer {
  const raw = env.OPEN_BANKING_DATA_KEY;
  if (!raw) throw new Error("OPEN_BANKING_DATA_KEY is not configured");
  // Accept hex (64 chars) or base64; require 32 bytes for AES-256.
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("OPEN_BANKING_DATA_KEY must decode to 32 bytes");
  return key;
}

/** True when encryption is usable (a valid key is configured). */
export function encryptionAvailable(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptField(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptField(payload: string): string {
  const key = loadKey();
  const [prefix, ivB64, tagB64, ctB64] = payload.split(".");
  if (prefix !== PREFIX || !ivB64 || !tagB64 || !ctB64) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Encrypt a JSON-serialisable object (e.g. provider tokens) to a single string. */
export function encryptJson(value: unknown): string {
  return encryptField(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptField(payload)) as T;
}
