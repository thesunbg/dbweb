import type { FastifyInstance, FastifyReply } from "fastify";
import ExcelJS from "exceljs";
import type { DbKind } from "@dbweb/shared-types";
import { getAdapter } from "../services/adapter-pool.js";

interface ExportQuery {
  database: string;
  table: string;
  format: "json" | "csv" | "xlsx";
  limit?: string;
}

/**
 * Single-table dump endpoint. Builds a select-all (or `db.coll.find()` on
 * Mongo) and streams the formatted output. By default the export is
 * unbounded — the user clicked "Export CSV" on a table expecting *the
 * whole table*, not a silently capped slice. Callers who do want a cap
 * pass `?limit=<n>`.
 *
 * The buffered (in-memory) encoder is fine for small/medium tables; for
 * really huge dumps (multi-GB) the user should reach for
 * mysqldump/pg_dump/mongoexport. Switching this endpoint to a streaming
 * encoder is the right follow-up if anyone reports OOM.
 */

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/connections/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as ExportQuery;
    if (!q.database || !q.table || !q.format) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: "database, table, format required" } });
    }
    if (!["json", "csv", "xlsx"].includes(q.format)) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: "format must be json|csv|xlsx" } });
    }
    // When the client passes `?limit=N` we honor it; otherwise we leave the
    // row count uncapped on purpose (see the comment on this endpoint).
    const parsedLimit = q.limit ? parseInt(q.limit, 10) : NaN;
    const maxRows: number | undefined =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

    let adapter;
    try {
      adapter = await getAdapter(id);
    } catch (err) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "CONNECT_FAILED", message: (err as Error).message } });
    }

    if (adapter.kind === "redis" || adapter.kind === "dragonfly") {
      return reply.code(400).send({
        ok: false,
        error: { code: "NOT_SUPPORTED", message: "Export not applicable to key-value stores" },
      });
    }

    const statement = buildSelectAll(adapter.kind, q.database, q.table, maxRows);
    let result;
    try {
      // The adapter's `execute` uses its own internal default cap when
      // `maxRows` is omitted (1000 rows). For an export endpoint that
      // default would silently truncate; pass MAX_SAFE_INTEGER so the
      // adapter's truncate-check is a no-op when the caller asked for "all".
      result = await adapter.execute(statement, {
        maxRows: maxRows ?? Number.MAX_SAFE_INTEGER,
      });
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "EXPORT_FAILED", message: (err as Error).message },
      });
    }

    const safeName = q.table.replace(/[^\w.-]/g, "_");
    const filename = `${safeName}.${q.format}`;

    if (q.format === "json") {
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      const docs = result.rows.map((r) =>
        Object.fromEntries(result.fields.map((f, i) => [f, r[i]])),
      );
      return JSON.stringify(docs, jsonReplacer, 2);
    }

    if (q.format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      // Prepend UTF-8 BOM so Excel auto-detects encoding and renders Unicode
      // text (Vietnamese etc.) correctly without an Import-Wizard detour.
      return "﻿" + rowsToCsv(result.fields, result.rows);
    }

    // xlsx — stream the workbook directly into the response. ExcelJS only
    // exposes a buffer API for `xlsx.write`, but the buffer is built lazily
    // and acceptably fast for up to ~100k rows. For huge dumps the user
    // should pick JSON/CSV.
    reply.header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return rowsToXlsx(result.fields, result.rows, safeName);
  });
}

/**
 * Build a dialect-aware SELECT *. Mongo gets a shell expression because the
 * adapter dispatches on the `db.` prefix; Redis is rejected before this is
 * called.
 *
 * `maxRows = undefined` means "no cap" — emit the statement without a
 * LIMIT/TOP/FETCH clause so the whole table comes back. The route layer
 * decides whether to cap; this helper just renders what it's told.
 */
function buildSelectAll(
  kind: DbKind,
  database: string,
  table: string,
  maxRows: number | undefined,
): string {
  if (kind === "mongodb") {
    // The shell evaluator only auto-limits when the user didn't set one;
    // we only emit an explicit `.limit()` when the caller actually wants
    // a cap. Without it the runner pulls every document.
    return maxRows == null
      ? `db.${table}.find()`
      : `db.${table}.find().limit(${maxRows})`;
  }
  const t = quoteSqlTable(kind, table);
  if (kind === "mssql") return maxRows == null ? `SELECT * FROM ${t}` : `SELECT TOP ${maxRows} * FROM ${t}`;
  if (kind === "oracle")
    return maxRows == null
      ? `SELECT * FROM ${t}`
      : `SELECT * FROM ${t} FETCH FIRST ${maxRows} ROWS ONLY`;
  if (kind === "clickhouse") {
    // ClickHouse takes LIMIT just like Postgres but its `database.table`
    // qualification doesn't survive the SQL-quoting helper (which targets
    // Postgres-style "schema"."table"). Quote each part with backticks and
    // build the qualified name directly.
    const dot = table.indexOf(".");
    const w = (s: string) => `\`${s.replace(/`/g, "``")}\``;
    const qualified = dot === -1 ? w(table) : `${w(table.slice(0, dot))}.${w(table.slice(dot + 1))}`;
    return maxRows == null
      ? `SELECT * FROM ${qualified}`
      : `SELECT * FROM ${qualified} LIMIT ${maxRows}`;
  }
  // postgres / mysql / mariadb
  return maxRows == null ? `SELECT * FROM ${t}` : `SELECT * FROM ${t} LIMIT ${maxRows}`;
  // `database` is currently unused at this layer — the adapter selects the
  // right DB internally based on its own state. Kept on the signature so we
  // can route per-DB pool selection later without changing callers.
  void database;
}

function quoteSqlTable(kind: DbKind, name: string): string {
  const dot = name.indexOf(".");
  const [schema, table] =
    dot === -1 ? [null, name] : [name.slice(0, dot), name.slice(dot + 1)];
  if (kind === "mssql") {
    const w = (s: string) => `[${s.replace(/]/g, "]]")}]`;
    return schema ? `${w(schema)}.${w(table)}` : w(table);
  }
  if (kind === "postgres" || kind === "oracle") {
    const w = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return schema ? `${w(schema)}.${w(table)}` : w(table);
  }
  const w = (s: string) => `\`${s.replace(/`/g, "``")}\``;
  return schema ? `${w(schema)}.${w(table)}` : w(table);
}

/**
 * Coerce a Mongo/BSON-flavored value to a plain string scalar before CSV/Excel
 * serialization. Without this, ObjectId and Date go through JSON.stringify
 * and gain literal `"..."` wrappers — which then collide with CSV's own
 * quoting rules and produce `"""hex"""` triple-quoted cells.
 */
function toCellValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const bson = (v as { _bsontype?: string })._bsontype;
    if (bson === "ObjectID" || bson === "ObjectId") {
      return (v as { toString(): string }).toString();
    }
    return JSON.stringify(v, jsonReplacer);
  }
  return String(v);
}

function csvEscape(v: unknown): string {
  const cell = toCellValue(v);
  if (cell === null) return "";
  // Normalize every flavour of in-field line break to CRLF. Excel for Mac
  // famously respects quote-state for embedded CRLF but treats a *lone* LF
  // as a hard row terminator even inside `"…"` — so a multi-line text field
  // (Vietnamese poems, addresses, JSON blobs with `\n`) silently truncates
  // the import. Forcing CRLF here keeps embedded line breaks visible
  // *and* parseable.
  const s = String(cell).replace(/\r\n|\r|\n/g, "\r\n");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(fields: string[], rows: unknown[][]): string {
  const lines: string[] = [fields.map((f) => csvEscape(f)).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  // CRLF per RFC4180. Excel for Mac in particular needs CRLF as the record
  // terminator so it can tell a real row boundary apart from a literal `\n`
  // embedded inside a quoted field — with LF-only files it often treats
  // the embedded newline as a record break and truncates the import after
  // a few thousand rows.
  return lines.join("\r\n");
}

async function rowsToXlsx(
  fields: string[],
  rows: unknown[][],
  sheetName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // Excel caps sheet names at 31 chars and disallows certain symbols.
  const safeSheet = sheetName.slice(0, 31).replace(/[\\/?*\[\]:]/g, "_") || "Sheet1";
  const sheet = wb.addWorksheet(safeSheet);

  sheet.columns = fields.map((f) => ({ header: f, key: f, width: Math.min(40, Math.max(10, f.length + 2)) }));
  // Style the header so the dump is immediately readable when opened.
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F0F0" } };

  for (const r of rows) {
    const cells: Record<string, string | number | boolean | null> = {};
    fields.forEach((f, i) => {
      // Same coercion as CSV — keeps ObjectId hex strings and Date ISO
      // strings as scalar cells, JSON-encodes only plain nested objects.
      cells[f] = toCellValue(r[i]);
    });
    sheet.addRow(cells);
  }

  // exceljs returns ArrayBuffer-like; cast to Node Buffer for Fastify.
  const ab = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return Buffer.from(ab);
}

function jsonReplacer(_k: string, v: unknown): unknown {
  // ObjectId from either driver line — fall back to its hex string form.
  if (v && typeof v === "object") {
    const bson = (v as { _bsontype?: string })._bsontype;
    if (bson === "ObjectID" || bson === "ObjectId") {
      return (v as { toString(): string }).toString();
    }
  }
  return v;
}

function sendError(reply: FastifyReply, code: string, message: string): void {
  void reply.code(400).send({ ok: false, error: { code, message } });
}
void sendError; // reserved for future fine-grained errors
