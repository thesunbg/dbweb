import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, config } from "../config.js";

const ALGO = "aes-256-gcm";
const KEY_ACCOUNT = "master-key";

/**
 * Returns a 32-byte symmetric key. On macOS it is stored in the OS Keychain
 * via `keytar`; on first run we generate one. If keytar isn't available
 * (e.g. headless Linux), we fall back to a key file in dataDir.
 *
 * The key never leaves the server process. Passwords sent to the client are
 * always redacted.
 */
let cachedKey: Buffer | null = null;

export async function getMasterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  if (!config.useFileVault) {
    try {
      const keytar = await import("keytar");
      const existing = await keytar.getPassword(APP_NAME, KEY_ACCOUNT);
      if (existing) {
        cachedKey = Buffer.from(existing, "base64");
        return cachedKey;
      }
      const fresh = randomBytes(32);
      await keytar.setPassword(APP_NAME, KEY_ACCOUNT, fresh.toString("base64"));
      cachedKey = fresh;
      return cachedKey;
    } catch {
      // Fall through to file vault if keytar fails to load.
    }
  }

  mkdirSync(config.dataDir, { recursive: true });
  const keyFile = join(config.dataDir, "vault.key");
  if (existsSync(keyFile)) {
    cachedKey = Buffer.from(readFileSync(keyFile, "utf8"), "base64");
    return cachedKey;
  }
  const fresh = randomBytes(32);
  writeFileSync(keyFile, fresh.toString("base64"), { mode: 0o600 });
  cachedKey = fresh;
  return cachedKey;
}

export async function encrypt(plain: string): Promise<string> {
  const key = await getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export async function decrypt(payload: string): Promise<string> {
  const [ivB64, tagB64, encB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Malformed cipher payload");
  const key = await getMasterKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/** Derive a one-off key from a passphrase — used for export bundles, not the vault. */
export function keyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}
