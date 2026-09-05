import { nanoid } from "nanoid";
import type { ConnectionColor, ConnectionConfig, ConnectionInput, DbKind, SshConfig } from "@dbweb/shared-types";
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
  color: string | null;
  read_only: number;
  ssh_cipher: string | null;
  options: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: Row, password?: string, ssh?: SshConfig | null): ConnectionConfig {
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
    color: (row.color as ConnectionColor | null) ?? null,
    readOnly: row.read_only === 1,
    ssh: ssh === undefined ? (row.ssh_cipher ? { host: "", port: 22, username: "", hasSecret: true } : null) : ssh,
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
  // Public listing never includes secrets — but the SSH host/user are not
  // secret and the sidebar needs them, so decrypt and strip per row.
  const out: ConnectionConfig[] = [];
  for (const r of rows) out.push(rowToConfig(r, undefined, await publicSsh(r.ssh_cipher)));
  return out;
}

/** SSH config with the secret fields removed (password / key / passphrase). */
async function publicSsh(cipher: string | null): Promise<SshConfig | null> {
  if (!cipher) return null;
  try {
    const full = JSON.parse(await decrypt(cipher)) as SshConfig;
    return {
      host: full.host,
      port: full.port,
      username: full.username,
      hasSecret: Boolean(full.password || full.privateKey),
    };
  } catch {
    return null;
  }
}

async function fullSsh(cipher: string | null): Promise<SshConfig | null> {
  if (!cipher) return null;
  return JSON.parse(await decrypt(cipher)) as SshConfig;
}

export async function getConnection(id: string, withSecret = false): Promise<ConnectionConfig | null> {
  const row = getDb().prepare<[string], Row>("SELECT * FROM connections WHERE id = ?").get(id);
  if (!row) return null;
  if (!withSecret) return rowToConfig(row, undefined, await publicSsh(row.ssh_cipher));
  const password = row.password_cipher ? await decrypt(row.password_cipher) : undefined;
  return rowToConfig(row, password, await fullSsh(row.ssh_cipher));
}

export async function createConnection(input: ConnectionInput): Promise<ConnectionConfig> {
  const id = nanoid(12);
  const now = new Date().toISOString();
  const cipher = input.password ? await encrypt(input.password) : null;
  const sshCipher = input.ssh?.host ? await encrypt(JSON.stringify(stripSshMeta(input.ssh))) : null;
  getDb()
    .prepare(
      `INSERT INTO connections
       (id, name, kind, host, port, username, password_cipher, database_name, group_name, color, read_only, ssh_cipher, options, created_at, updated_at)
       VALUES (@id, @name, @kind, @host, @port, @username, @cipher, @database, @group, @color, @readOnly, @sshCipher, @options, @now, @now)`,
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
      color: input.color ?? null,
      readOnly: input.readOnly ? 1 : 0,
      sshCipher,
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
    color: patch.color !== undefined ? patch.color : existing.color,
    readOnly: patch.readOnly !== undefined ? patch.readOnly : existing.readOnly,
    ssh: mergeSsh(patch.ssh, existing.ssh),
    options: patch.options ?? existing.options,
  };
  const cipher = merged.password ? await encrypt(merged.password) : null;
  const sshCipher = merged.ssh?.host ? await encrypt(JSON.stringify(stripSshMeta(merged.ssh))) : null;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE connections SET
        name = @name, kind = @kind, host = @host, port = @port,
        username = @username, password_cipher = @cipher,
        database_name = @database, group_name = @group, color = @color,
        read_only = @readOnly, ssh_cipher = @sshCipher,
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
      color: merged.color ?? null,
      readOnly: merged.readOnly ? 1 : 0,
      sshCipher,
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
    color: src.color,
    readOnly: src.readOnly,
    ssh: src.ssh,
    options: src.options,
  });
}

/**
 * `PATCH { ssh: null }` clears the tunnel; `ssh` omitted keeps it; an object
 * with blank secret fields keeps the stored secrets (the form never sends
 * them back).
 */
function mergeSsh(patch: SshConfig | null | undefined, existing: SshConfig | null | undefined): SshConfig | null {
  if (patch === undefined) return existing ?? null;
  if (patch === null || !patch.host) return null;
  return {
    host: patch.host,
    port: patch.port || 22,
    username: patch.username,
    password: patch.password || existing?.password,
    privateKey: patch.privateKey || existing?.privateKey,
    passphrase: patch.passphrase || existing?.passphrase,
  };
}

function stripSshMeta(ssh: SshConfig): SshConfig {
  const { hasSecret: _h, ...rest } = ssh;
  return rest;
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
