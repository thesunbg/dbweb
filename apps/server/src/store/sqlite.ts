import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, "dbweb.sqlite");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password_cipher TEXT,
      database_name TEXT,
      options TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query_history (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      database_name TEXT,
      statement TEXT NOT NULL,
      elapsed_ms INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS saved_queries (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      name TEXT NOT NULL,
      statement TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
    );
  `);

  addColumn(database, "connections", "group_name", "TEXT");
  addColumn(database, "connections", "color", "TEXT");
  addColumn(database, "connections", "read_only", "INTEGER NOT NULL DEFAULT 0");
  // Encrypted JSON blob (host/port/user/password/key) — see store/connections.ts.
  addColumn(database, "connections", "ssh_cipher", "TEXT");

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snippets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      statement TEXT NOT NULL,
      kind TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      database_name TEXT,
      name TEXT NOT NULL,
      statement TEXT NOT NULL,
      interval_min INTEGER NOT NULL DEFAULT 60,
      cron TEXT,
      condition_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_status TEXT,
      last_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      schedule_name TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );
  `);
}

/** SQLite has no ADD COLUMN IF NOT EXISTS — check the table shape first so
 *  existing ~/.dbweb/dbweb.sqlite files migrate in place on startup. */
function addColumn(
  database: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
