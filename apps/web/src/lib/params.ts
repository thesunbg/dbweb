import type { DbKind } from "@dbweb/shared-types";
import { sqlLiteral } from "./sql.js";

/**
 * Query parameters: `{{name}}` is substituted verbatim (identifiers, raw
 * fragments) and `:name` as a quoted literal. Both are ignored inside
 * string literals, comments and `::casts`. `:name` is only recognised for
 * SQL kinds — Mongo/Redis statements use `{{name}}` only.
 */
export interface ParamRef {
  name: string;
  raw: boolean;
}

export function findParams(kind: DbKind, statement: string): ParamRef[] {
  const seen = new Map<string, ParamRef>();
  const sql = ["mysql", "postgres", "oracle", "mssql", "clickhouse"].includes(kind);
  const n = statement.length;
  let i = 0;
  while (i < n) {
    const ch = statement[i]!;
    // string literal
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n && statement[j] !== ch) j += statement[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === "-" && statement[i + 1] === "-") {
      const end = statement.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "/" && statement[i + 1] === "*") {
      const end = statement.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "/" && statement[i + 1] === "/") {
      const end = statement.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "{" && statement[i + 1] === "{") {
      const m = /^\{\{\s*([A-Za-z_][\w]*)\s*\}\}/.exec(statement.slice(i));
      if (m) {
        if (!seen.has(m[1]!)) seen.set(m[1]!, { name: m[1]!, raw: true });
        i += m[0].length;
        continue;
      }
    }
    if (sql && ch === ":" && statement[i + 1] !== ":" && statement[i - 1] !== ":" && /[A-Za-z_]/.test(statement[i + 1] ?? "")) {
      // Not preceded by a word char (avoid `a:b` in JSON-ish text).
      if (!/[\w]/.test(statement[i - 1] ?? " ")) {
        const m = /^:([A-Za-z_]\w*)/.exec(statement.slice(i));
        if (m) {
          if (!seen.has(m[1]!)) seen.set(m[1]!, { name: m[1]!, raw: false });
          i += m[0].length;
          continue;
        }
      }
    }
    i++;
  }
  return [...seen.values()];
}

/** Numbers stay bare, NULL stays NULL, everything else is quoted. */
export function substituteParams(kind: DbKind, statement: string, values: Record<string, string>): string {
  const sql = ["mysql", "postgres", "oracle", "mssql", "clickhouse"].includes(kind);
  let out = statement.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (m, name: string) => (name in values ? values[name]! : m));
  if (sql) {
    out = out.replace(/(^|[^\w:]):([A-Za-z_]\w*)/g, (m, pre: string, name: string) => {
      if (!(name in values)) return m;
      const v = values[name]!.trim();
      if (v === "" || v.toUpperCase() === "NULL") return `${pre}NULL`;
      if (/^-?\d+(\.\d+)?$/.test(v)) return `${pre}${v}`;
      if (/^(true|false)$/i.test(v)) return `${pre}${v.toUpperCase()}`;
      return `${pre}${sqlLiteral(v)}`;
    });
  }
  return out;
}
