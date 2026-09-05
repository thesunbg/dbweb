import { nanoid } from "nanoid";
import type { DbKind, SnippetDto } from "@dbweb/shared-types";
import { getDb } from "./sqlite.js";

interface Row {
  id: string;
  name: string;
  statement: string;
  kind: string | null;
  created_at: string;
}

const toDto = (r: Row): SnippetDto => ({
  id: r.id,
  name: r.name,
  statement: r.statement,
  kind: (r.kind as DbKind | null) ?? null,
  createdAt: r.created_at,
});

export function listSnippets(): SnippetDto[] {
  return getDb().prepare<[], Row>("SELECT * FROM snippets ORDER BY name COLLATE NOCASE").all().map(toDto);
}

export function createSnippet(input: { name: string; statement: string; kind?: DbKind | null }): SnippetDto {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO snippets (id, name, statement, kind, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, input.name, input.statement, input.kind ?? null, createdAt);
  return { id, name: input.name, statement: input.statement, kind: input.kind ?? null, createdAt };
}

export function updateSnippet(id: string, patch: { name?: string; statement?: string; kind?: DbKind | null }): SnippetDto | null {
  const db = getDb();
  const existing = db.prepare<[string], Row>("SELECT * FROM snippets WHERE id = ?").get(id);
  if (!existing) return null;
  db.prepare("UPDATE snippets SET name = ?, statement = ?, kind = ? WHERE id = ?").run(
    patch.name ?? existing.name,
    patch.statement ?? existing.statement,
    patch.kind !== undefined ? patch.kind : existing.kind,
    id,
  );
  return toDto(db.prepare<[string], Row>("SELECT * FROM snippets WHERE id = ?").get(id)!);
}

export function deleteSnippet(id: string): boolean {
  return getDb().prepare("DELETE FROM snippets WHERE id = ?").run(id).changes > 0;
}
