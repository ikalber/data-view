import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.DATA_VIEW_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "DATA_VIEW_MASTER_KEY not set — generate one with `openssl rand -base64 32`",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("DATA_VIEW_MASTER_KEY must decode to 32 bytes (base64 of 32 random bytes)");
  }
  return buf;
}

/**
 * Encrypts secrets with AES-256-GCM. Output is a single string of the form
 * `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>` so we can rotate the format later.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(encoded: string): string {
  const [version, ivB64, tagB64, ctB64] = encoded.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Unrecognized secret format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
