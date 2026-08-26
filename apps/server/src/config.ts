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
  /**
   * Minutes of inactivity after which the server exits on its own. 0 disables
   * it — that is the default, so `pnpm dev` never dies under you. The
   * LaunchAgent sets it so the installed app releases its ~50MB once you stop
   * using it; scripts/dbweb.app starts it again on demand.
   */
  idleExitMinutes: Number(process.env.DBWEB_IDLE_EXIT_MIN ?? 0),
} as const;
