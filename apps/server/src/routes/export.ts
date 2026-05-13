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
 * Mongo) and streams the formatted output. The hard cap is generous — at
 * 1M rows in a single table we're already past the point where an admin
 * tool is the right choice; large dumps belong in mysqldump/pg_dump/
 * mongoexport. We keep this in-memory for v1; switching to a streaming
 * encoder is a follow-up if anyone hits the cap.
 */
const MAX_ROWS = 1_000_000;

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
    const maxRows = Math.min(
      MAX_ROWS,
      q.limit ? Math.max(1, parseInt(q.limit, 10) || MAX_ROWS) : MAX_ROWS,
    );

    let adapter;
    try {
      adapter = await getAdapter(id);
    } catch (err) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "CONNECT_FAILED", message: (err as Error).message } });
    }

    if (adapter.kind === "redis") {
      return reply.code(400).send({
        ok: false,
        error: { code: "NOT_SUPPORTED", message: "Export not applicable to Redis keys" },
      });
    }

    const statement = buildSelectAll(adapter.kind, q.database, q.table, maxRows);
    let result;
    try {
      result = await adapter.execute(statement, { maxRows });
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
 */
function buildSelectAll(
  kind: DbKind,
  database: string,
  table: string,
  maxRows: number,
): string {
  if (kind === "mongodb") {
    // The shell evaluator only auto-limits when the user didn't set one, so
    // an explicit .limit() is needed here to honor the cap.
    return `db.${table}.find().limit(${maxRows})`;
  }
  const t = quoteSqlTable(kind, table);
  if (kind === "mssql") return `SELECT TOP ${maxRows} * FROM ${t}`;
  if (kind === "oracle") return `SELECT * FROM ${t} FETCH FIRST ${maxRows} ROWS ONLY`;
  if (kind === "postgres") {
    // For Postgres we also split schema-qualified names; the existing helper
    // already handles both cases.
    return `SELECT * FROM ${t} LIMIT ${maxRows}`;
  }
  // mysql
  return `SELECT * FROM ${t} LIMIT ${maxRows}`;
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
  const s = String(cell);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(fields: string[], rows: unknown[][]): string {
  const lines: string[] = [fields.map((f) => csvEscape(f)).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\n");
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
