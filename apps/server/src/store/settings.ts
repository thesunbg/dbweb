import { getDb } from "./sqlite.js";
import { decrypt, encrypt } from "./secrets.js";

/** Key/value app settings. Values flagged secret are encrypted at rest. */
const SECRET_KEYS = new Set(["anthropicApiKey"]);

export function getSetting(key: string): string | null {
  const row = getDb().prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

export async function getSecretSetting(key: string): Promise<string | null> {
  const raw = getSetting(key);
  if (!raw) return null;
  return SECRET_KEYS.has(key) ? decrypt(raw) : raw;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  const db = getDb();
  if (value === null || value === "") {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  const stored = SECRET_KEYS.has(key) ? await encrypt(value) : value;
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, stored);
}
