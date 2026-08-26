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
  group_name: string | null;
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
    group: row.group_name,
    options: row.options ? (JSON.parse(row.options) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConnections(): Promise<ConnectionConfig[]> {
  // Grouped first (alphabetically), then loose ones — matches the sidebar's
  // rendering order so the list doesn't jump around after a drag.
  const rows = getDb()
    .prepare<[], Row>("SELECT * FROM connections ORDER BY group_name IS NULL, group_name, name")
    .all();
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
       (id, name, kind, host, port, username, password_cipher, database_name, group_name, options, created_at, updated_at)
       VALUES (@id, @name, @kind, @host, @port, @username, @cipher, @database, @group, @options, @now, @now)`,
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
      group: normalizeGroup(input.group),
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
    // `??` can't clear a field — moving a connection back to "Ungrouped" sends
    // group: null, which must survive the merge.
    group: patch.group !== undefined ? patch.group : existing.group,
    options: patch.options ?? existing.options,
  };
  const cipher = merged.password ? await encrypt(merged.password) : null;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE connections SET
        name = @name, kind = @kind, host = @host, port = @port,
        username = @username, password_cipher = @cipher,
        database_name = @database, group_name = @group,
        options = @options, updated_at = @now
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
      group: normalizeGroup(merged.group),
      options: merged.options ? JSON.stringify(merged.options) : null,
      now,
    });
  return getConnection(id);
}

/**
 * Clone an existing connection into a brand-new one. Copies every field —
 * including the (decrypted then re-encrypted) password and options — so the
 * duplicate is immediately usable. The name gets a " (copy)" suffix, made
 * unique against the current set so repeated duplicates don't collide.
 */
export async function duplicateConnection(id: string): Promise<ConnectionConfig | null> {
  const src = await getConnection(id, true);
  if (!src) return null;
  const existingNames = new Set((await listConnections()).map((c) => c.name));
  return createConnection({
    name: uniqueCopyName(src.name, existingNames),
    kind: src.kind,
    host: src.host,
    port: src.port,
    username: src.username,
    password: src.password,
    database: src.database,
    group: src.group,
    options: src.options,
  });
}

/** Trims and collapses "" to null so blank input never creates a phantom
 *  group whose header renders as an empty string. */
function normalizeGroup(group: string | null | undefined): string | null {
  const trimmed = group?.trim();
  return trimmed ? trimmed : null;
}

function uniqueCopyName(base: string, taken: Set<string>): string {
  const first = `${base} (copy)`;
  if (!taken.has(first)) return first;
  for (let i = 2; ; i++) {
    const candidate = `${base} (copy ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function deleteConnection(id: string): boolean {
  const res = getDb().prepare("DELETE FROM connections WHERE id = ?").run(id);
  return res.changes > 0;
}
