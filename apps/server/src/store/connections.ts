import { nanoid } from "nanoid";
import type { ConnectionConfig, ConnectionInput, DbKind } from "@dbweb/shared-types";
import { getDb } from "./sqlite.js";
import { decrypt, encrypt } from "./secrets.js";

interface Row {
  id: string;
  name: string;
  kind: string;
  host: string;
  port: number;
  username: string | null;
  password_cipher: string | null;
  database_name: string | null;
  options: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: Row, password?: string): ConnectionConfig {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DbKind,
    host: row.host,
    port: row.port,
    username: row.username ?? undefined,
    password,
    database: row.database_name ?? undefined,
    options: row.options ? (JSON.parse(row.options) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConnections(): Promise<ConnectionConfig[]> {
  const rows = getDb().prepare<[], Row>("SELECT * FROM connections ORDER BY name").all();
  // Public listing never includes secrets.
  return rows.map((r) => rowToConfig(r));
}

export async function getConnection(id: string, withSecret = false): Promise<ConnectionConfig | null> {
  const row = getDb().prepare<[string], Row>("SELECT * FROM connections WHERE id = ?").get(id);
  if (!row) return null;
  if (!withSecret) return rowToConfig(row);
  const password = row.password_cipher ? await decrypt(row.password_cipher) : undefined;
  return rowToConfig(row, password);
}

export async function createConnection(input: ConnectionInput): Promise<ConnectionConfig> {
  const id = nanoid(12);
  const now = new Date().toISOString();
  const cipher = input.password ? await encrypt(input.password) : null;
  getDb()
    .prepare(
      `INSERT INTO connections
       (id, name, kind, host, port, username, password_cipher, database_name, options, created_at, updated_at)
       VALUES (@id, @name, @kind, @host, @port, @username, @cipher, @database, @options, @now, @now)`,
    )
    .run({
      id,
      name: input.name,
      kind: input.kind,
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      cipher,
      database: input.database ?? null,
      options: input.options ? JSON.stringify(input.options) : null,
      now,
    });
  const created = await getConnection(id);
  if (!created) throw new Error("Failed to read back created connection");
  return created;
}

export async function updateConnection(
  id: string,
  patch: Partial<ConnectionInput>,
): Promise<ConnectionConfig | null> {
  const existing = await getConnection(id, true);
  if (!existing) return null;
  const merged: ConnectionInput = {
    name: patch.name ?? existing.name,
    kind: patch.kind ?? existing.kind,
    host: patch.host ?? existing.host,
    port: patch.port ?? existing.port,
    username: patch.username ?? existing.username,
    password: patch.password ?? existing.password,
    database: patch.database ?? existing.database,
    options: patch.options ?? existing.options,
  };
  const cipher = merged.password ? await encrypt(merged.password) : null;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE connections SET
        name = @name, kind = @kind, host = @host, port = @port,
        username = @username, password_cipher = @cipher,
        database_name = @database, options = @options, updated_at = @now
       WHERE id = @id`,
    )
    .run({
      id,
      name: merged.name,
      kind: merged.kind,
      host: merged.host,
      port: merged.port,
      username: merged.username ?? null,
      cipher,
      database: merged.database ?? null,
      options: merged.options ? JSON.stringify(merged.options) : null,
      now,
    });
  return getConnection(id);
}

export function deleteConnection(id: string): boolean {
  const res = getDb().prepare("DELETE FROM connections WHERE id = ?").run(id);
  return res.changes > 0;
}
