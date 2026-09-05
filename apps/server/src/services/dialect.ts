import type { DbKind } from "@dbweb/shared-types";

/** Server-side identifier/literal quoting for adapters without insertRows. */
export function quoteIdent(kind: DbKind, s: string): string {
  switch (kind) {
    case "postgres":
    case "oracle":
      return '"' + s.replace(/"/g, '""') + '"';
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    default:
      return "`" + s.replace(/`/g, "``") + "`";
  }
}

export function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

export function tableRef(kind: DbKind, database: string, table: string): string {
  const parts = table.split(".");
  if (kind === "postgres") {
    return parts.length > 1 ? parts.map((p) => quoteIdent(kind, p)).join(".") : `"public".${quoteIdent(kind, table)}`;
  }
  if (kind === "mssql") {
    return parts.length > 1 ? `${quoteIdent(kind, database)}.${parts.map((p) => quoteIdent(kind, p)).join(".")}` : `${quoteIdent(kind, database)}.dbo.${quoteIdent(kind, table)}`;
  }
  return `${quoteIdent(kind, database)}.${parts.map((p) => quoteIdent(kind, p)).join(".")}`;
}

export function buildMultiInsert(kind: DbKind, database: string, table: string, columns: string[], rows: unknown[][]): string {
  const cols = columns.map((c) => quoteIdent(kind, c)).join(", ");
  const values = rows.map((r) => `(${columns.map((_, i) => literal(r[i])).join(", ")})`).join(",\n");
  if (kind === "oracle") {
    // Oracle has no multi-row VALUES; INSERT ALL is the idiom.
    const ref = tableRef(kind, database, table);
    const body = rows.map((r) => `INTO ${ref} (${cols}) VALUES (${columns.map((_, i) => literal(r[i])).join(", ")})`).join("\n");
    return `INSERT ALL\n${body}\nSELECT 1 FROM dual`;
  }
  return `INSERT INTO ${tableRef(kind, database, table)} (${cols}) VALUES\n${values}`;
}
