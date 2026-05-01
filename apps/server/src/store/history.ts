import { nanoid } from "nanoid";
import type { QueryHistoryEntry } from "@dbweb/shared-types";
import { getDb } from "./sqlite.js";

interface Row {
  id: string;
  connection_id: string;
  database_name: string | null;
  statement: string;
  elapsed_ms: number;
  row_count: number;
  error: string | null;
  created_at: string;
}

function rowToEntry(row: Row): QueryHistoryEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    database: row.database_name ?? undefined,
    statement: row.statement,
    elapsedMs: row.elapsed_ms,
    rowCount: row.row_count,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

export function recordQuery(entry: Omit<QueryHistoryEntry, "id" | "createdAt">): QueryHistoryEntry {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO query_history
       (id, connection_id, database_name, statement, elapsed_ms, row_count, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      entry.connectionId,
      entry.database ?? null,
      entry.statement,
      entry.elapsedMs,
      entry.rowCount,
      entry.error ?? null,
      createdAt,
    );
  return { ...entry, id, createdAt };
}

export function listHistory(connectionId: string, limit = 100): QueryHistoryEntry[] {
  const rows = getDb()
    .prepare<[string, number], Row>(
      `SELECT * FROM query_history WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(connectionId, limit);
  return rows.map(rowToEntry);
}
