import { nanoid } from "nanoid";
import { getDb } from "./sqlite.js";

export interface SavedQuery {
  id: string;
  connectionId: string;
  name: string;
  statement: string;
  createdAt: string;
}

interface Row {
  id: string;
  connection_id: string;
  name: string;
  statement: string;
  created_at: string;
}

const toEntry = (r: Row): SavedQuery => ({
  id: r.id,
  connectionId: r.connection_id,
  name: r.name,
  statement: r.statement,
  createdAt: r.created_at,
});

export function listSaved(connectionId: string): SavedQuery[] {
  const rows = getDb()
    .prepare<[string], Row>(
      `SELECT * FROM saved_queries WHERE connection_id = ? ORDER BY created_at DESC`,
    )
    .all(connectionId);
  return rows.map(toEntry);
}

export function createSaved(connectionId: string, name: string, statement: string): SavedQuery {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO saved_queries (id, connection_id, name, statement, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, connectionId, name, statement, createdAt);
  return { id, connectionId, name, statement, createdAt };
}

export function deleteSaved(id: string): boolean {
  const res = getDb().prepare("DELETE FROM saved_queries WHERE id = ?").run(id);
  return res.changes > 0;
}
