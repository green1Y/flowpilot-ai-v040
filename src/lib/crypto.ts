import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM for integration credentials at rest.
// ENCRYPTION_KEY must be 32 bytes hex. If unset, crypto falls back to a
// dev-only ephemeral key and logs a loud warning — credentials then do not
// survive restarts. Production MUST set ENCRYPTION_KEY.
function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  // Fail closed in production: an ephemeral key would make every stored
  // credential undecryptable after a restart (silent data loss), which is
  // worse than refusing to start.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[security] ENCRYPTION_KEY is not set — refusing to use an ephemeral dev key in production"
    );
  }
  if (!(globalThis as any).__fpKeyWarned) {
    console.warn(
      "[security] ENCRYPTION_KEY is not set — using ephemeral dev key. Set ENCRYPTION_KEY in production."
    );
    (globalThis as any).__fpKeyWarned = true;
  }
  if (!(globalThis as any).__fpDevKey) {
    (globalThis as any).__fpDevKey = randomBytes(32);
  }
  return (globalThis as any).__fpDevKey as Buffer;
}

/** Encrypt plaintext → "iv:ciphertext:authTag" (hex). */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

/** Decrypt output of encrypt(). Throws on tampering. */
export function decrypt(payload: string): string {
  const key = getKey();
  const [ivHex, encHex, tagHex] = payload.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
