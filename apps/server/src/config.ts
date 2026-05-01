import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "dbweb";

export const config = {
  host: process.env.DBWEB_HOST ?? "127.0.0.1",
  port: Number(process.env.DBWEB_PORT ?? 4317),
  /** Local app data directory; encrypted store + logs live here. */
  dataDir: process.env.DBWEB_DATA_DIR ?? join(homedir(), `.${APP_NAME}`),
  /** When true, fall back to a passphrase-derived key instead of OS keychain. */
  useFileVault: process.env.DBWEB_FILE_VAULT === "1",
} as const;
