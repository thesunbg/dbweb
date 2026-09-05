import type { DbKind } from "@dbweb/shared-types";

/**
 * Dialect-aware SQL builders shared by the table browser, the tree context
 * menu and the editor helpers. Everything that quotes an identifier or
 * paginates lives here so the per-engine quirks stay in one place.
 */

export const SQL_KINDS: ReadonlySet<DbKind> = new Set(["mysql", "postgres", "oracle", "mssql", "clickhouse"]);
export const isSqlKind = (kind: DbKind): boolean => SQL_KINDS.has(kind);

export function quoteIdent(kind: DbKind, s: string): string {
  switch (kind) {
    case "postgres":
    case "oracle":
      return '"' + s.replace(/"/g, '""') + '"';
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "mysql":
    case "clickhouse":
      return "`" + s.replace(/`/g, "``") + "`";
    default:
      return s;
  }
}

/** Quote a possibly schema-qualified name (`schema.table`) part by part. */
export function quoteQualified(kind: DbKind, name: string): string {
  const dot = name.indexOf(".");
  if (dot === -1) return quoteIdent(kind, name);
  return `${quoteIdent(kind, name.slice(0, dot))}.${quoteIdent(kind, name.slice(dot + 1))}`;
}

/**
 * Fully-qualified table reference for browsing, where the query must work
 * regardless of the connection's default database:
 *   postgres  → "schema"."table" (listObjects already prefixes non-public schemas)
 *   mssql     → [db].dbo.[table]
 *   others    → `db`.`table`
 */
export function tableRef(kind: DbKind, database: string, table: string): string {
  if (kind === "postgres") {
    const dot = table.indexOf(".");
    const schema = dot === -1 ? "public" : table.slice(0, dot);
    const tbl = dot === -1 ? table : table.slice(dot + 1);
    return `${quoteIdent(kind, schema)}.${quoteIdent(kind, tbl)}`;
  }
  if (kind === "mssql") {
    if (table.includes(".")) return `${quoteIdent(kind, database)}.${quoteQualified(kind, table)}`;
    return `${quoteIdent(kind, database)}.dbo.${quoteIdent(kind, table)}`;
  }
  return `${quoteIdent(kind, database)}.${quoteQualified(kind, table)}`;
}

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

export type FilterOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "NOT LIKE" | "IN" | "IS NULL" | "IS NOT NULL";
export const FILTER_OPS: readonly FilterOp[] = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "NOT LIKE", "IN", "IS NULL", "IS NOT NULL"];
export interface Filter {
  column: string;
  op: FilterOp;
  value: string;
}
export const opNeedsValue = (op: FilterOp) => op !== "IS NULL" && op !== "IS NOT NULL";

export function buildWhere(kind: DbKind, filters: Filter[]): string {
  const parts: string[] = [];
  for (const f of filters) {
    const col = quoteIdent(kind, f.column);
    if (!opNeedsValue(f.op)) {
      parts.push(`${col} ${f.op}`);
    } else if (f.op === "IN") {
      const items = f.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length > 0) parts.push(`${col} IN (${items.map((s) => sqlLiteral(s)).join(", ")})`);
    } else if (f.value !== "") {
      parts.push(`${col} ${f.op} ${sqlLiteral(f.value)}`);
    }
  }
  return parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
}

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

export interface SelectOpts {
  where?: string;
  sort?: Sort | null;
  limit: number;
  offset?: number;
}

/** Paged, sortable SELECT * for the table browser. */
export function buildSelect(kind: DbKind, database: string, table: string, opts: SelectOpts): string {
  const ref = tableRef(kind, database, table);
  const where = opts.where ?? "";
  const offset = opts.offset ?? 0;
  const order = opts.sort ? ` ORDER BY ${quoteIdent(kind, opts.sort.column)} ${opts.sort.dir.toUpperCase()}` : "";

  if (kind === "mssql") {
    // OFFSET/FETCH requires an ORDER BY; (SELECT NULL) is the idiom for "any".
    const ord = order || " ORDER BY (SELECT NULL)";
    return `SELECT * FROM ${ref}${where}${ord} OFFSET ${offset} ROWS FETCH NEXT ${opts.limit} ROWS ONLY`;
  }
  if (kind === "oracle") {
    return `SELECT * FROM ${ref}${where}${order} OFFSET ${offset} ROWS FETCH NEXT ${opts.limit} ROWS ONLY`;
  }
  const off = offset > 0 ? ` OFFSET ${offset}` : "";
  return `SELECT * FROM ${ref}${where}${order} LIMIT ${opts.limit}${off}`;
}

export function buildCount(kind: DbKind, database: string, table: string, where = ""): string {
  return `SELECT COUNT(*) AS total FROM ${tableRef(kind, database, table)}${where}`;
}

export function buildDelete(kind: DbKind, database: string, table: string, pk: Record<string, unknown>): string {
  const cond = Object.entries(pk)
    .map(([k, v]) => `${quoteIdent(kind, k)} = ${sqlLiteral(v)}`)
    .join(" AND ");
  return `DELETE FROM ${tableRef(kind, database, table)} WHERE ${cond}`;
}

export function buildInsertTemplate(
  kind: DbKind,
  database: string,
  table: string,
  cols: { name: string; dataType: string; nullable: boolean; default?: string | null }[],
): string {
  const names = cols.map((c) => quoteIdent(kind, c.name)).join(", ");
  const values = cols
    .map((c) => `  ${c.default ? "DEFAULT" : c.nullable ? "NULL" : "''"} -- ${c.name} ${c.dataType}`)
    .join(",\n");
  return `INSERT INTO ${tableRef(kind, database, table)} (${names})\nVALUES (\n${values}\n)`;
}

/** Row → INSERT statement, for "Copy as INSERT" on a result row. */
export function rowToInsert(kind: DbKind, table: string, fields: string[], row: unknown[]): string {
  const names = fields.map((f) => quoteIdent(kind, f)).join(", ");
  const values = row.map((v) => sqlLiteral(v)).join(", ");
  return `INSERT INTO ${quoteQualified(kind, table)} (${names}) VALUES (${values});`;
}

/** "Select 100" for the editor — unqualified so it reads naturally there. */
export function buildSelectStatement(kind: DbKind, table: string, limit: number): string {
  const t = quoteQualified(kind, table);
  if (kind === "mssql") return `SELECT TOP ${limit} * FROM ${t}`;
  if (kind === "oracle") return `SELECT * FROM ${t} FETCH FIRST ${limit} ROWS ONLY`;
  return `SELECT * FROM ${t} LIMIT ${limit}`;
}

/** Per-dialect "describe table" query. */
export function buildShowColumns(kind: DbKind, qualified: string): string {
  const dot = qualified.indexOf(".");
  const [schema, table] = dot === -1 ? [null, qualified] : [qualified.slice(0, dot), qualified.slice(dot + 1)];
  const escTable = table.replace(/'/g, "''");
  const escSchema = (schema ?? "public").replace(/'/g, "''");

  if (kind === "mysql") return `SHOW COLUMNS FROM ${quoteQualified(kind, qualified)}`;
  if (kind === "clickhouse") return `DESCRIBE TABLE ${quoteQualified(kind, qualified)}`;
  if (kind === "postgres") {
    return `SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = '${escSchema}' AND table_name = '${escTable}'
ORDER BY ordinal_position`;
  }
  if (kind === "mssql") {
    return `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = '${escTable}'
ORDER BY ORDINAL_POSITION`;
  }
  if (kind === "oracle") {
    return `SELECT column_name, data_type, nullable, data_default
FROM all_tab_columns
WHERE owner = '${escSchema.toUpperCase()}' AND table_name = '${escTable.toUpperCase()}'
ORDER BY column_id`;
  }
  return `SELECT * FROM ${quoteQualified(kind, qualified)} LIMIT 0`;
}

/** "Show DDL" per dialect — the closest thing each engine has to SHOW CREATE. */
export function buildShowCreate(kind: DbKind, qualified: string): string | null {
  if (kind === "mysql") return `SHOW CREATE TABLE ${quoteQualified(kind, qualified)}`;
  if (kind === "clickhouse") return `SHOW CREATE TABLE ${quoteQualified(kind, qualified)}`;
  if (kind === "postgres") {
    const dot = qualified.indexOf(".");
    const [schema, table] = dot === -1 ? ["public", qualified] : [qualified.slice(0, dot), qualified.slice(dot + 1)];
    return `SELECT
  'CREATE TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E' (\\n' ||
  string_agg('  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) ||
    CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END, E',\\n' ORDER BY a.attnum) ||
  E'\\n);' AS ddl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = '${schema.replace(/'/g, "''")}' AND c.relname = '${table.replace(/'/g, "''")}'
GROUP BY n.nspname, c.relname`;
  }
  if (kind === "mssql") return `EXEC sp_help '${qualified.replace(/'/g, "''")}'`;
  if (kind === "oracle") {
    const dot = qualified.indexOf(".");
    const [schema, table] = dot === -1 ? [null, qualified] : [qualified.slice(0, dot), qualified.slice(dot + 1)];
    const owner = schema ? `, '${schema.toUpperCase().replace(/'/g, "''")}'` : "";
    return `SELECT DBMS_METADATA.GET_DDL('TABLE', '${table.toUpperCase().replace(/'/g, "''")}'${owner}) AS ddl FROM dual`;
  }
  return null;
}

/** EXPLAIN prefix per dialect, or null where the engine has no cheap form. */
export function buildExplain(kind: DbKind, statement: string): string | null {
  const s = statement.trim().replace(/;\s*$/, "");
  if (kind === "mysql") return `EXPLAIN ${s}`;
  if (kind === "postgres") return `EXPLAIN (ANALYZE false, VERBOSE false) ${s}`;
  if (kind === "clickhouse") return `EXPLAIN ${s}`;
  if (kind === "oracle") return `EXPLAIN PLAN FOR ${s}`;
  if (kind === "mssql") return `SET SHOWPLAN_TEXT ON;\nGO\n${s}`;
  return null;
}

/** sql-formatter language id per kind. */
export function formatterDialect(kind: DbKind): "mysql" | "postgresql" | "transactsql" | "plsql" | "sql" | null {
  switch (kind) {
    case "mysql":
      return "mysql";
    case "postgres":
      return "postgresql";
    case "mssql":
      return "transactsql";
    case "oracle":
      return "plsql";
    case "clickhouse":
      return "sql";
    default:
      return null;
  }
}
