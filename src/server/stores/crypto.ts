import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HttpError } from "../http";

/**
 * AES-256-GCM for store credentials. The connection id is bound as
 * additional authenticated data: a ciphertext copied onto another row
 * fails authentication instead of decrypting.
 * Format: v1.<iv>.<tag>.<ciphertext>, base64url.
 */
function key() {
  const raw = process.env.STORE_CREDENTIALS_KEY;
  const decoded = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (decoded.length !== 32)
    throw new HttpError(
      503,
      "Connexion de boutique indisponible : STORE_CREDENTIALS_KEY (32 octets en base64) n’est pas configurée.",
    );
  return decoded;
}

export function encryptSecret(plain: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}

export function decryptSecret(sealed: string, context: string) {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined)
    throw new Error("Secret de boutique illisible.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
