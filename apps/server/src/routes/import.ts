import type { FastifyInstance } from "fastify";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getAdapter } from "../services/adapter-pool.js";
import { getConnection } from "../store/connections.js";
import { buildMultiInsert } from "../services/dialect.js";

const parseSchema = z.object({
  name: z.string(),
  /** base64 file contents */
  data: z.string(),
  /** Parse only the first N rows for preview. */
  limit: z.number().int().positive().optional(),
  delimiter: z.string().max(1).optional(),
});

const importSchema = z.object({
  database: z.string().min(1),
  table: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  rows: z.array(z.array(z.unknown())).min(1),
});

export async function importRoutes(app: FastifyInstance): Promise<void> {
  /** Turns an uploaded CSV / XLSX into {columns, rows} for the mapping UI. */
  app.post("/api/import/parse", async (req, reply) => {
    const parsed = parseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    const buf = Buffer.from(parsed.data.data, "base64");
    try {
      const out = /\.xlsx?$/i.test(parsed.data.name) ? await parseXlsx(buf, parsed.data.limit) : parseCsv(buf.toString("utf8"), parsed.data.limit, parsed.data.delimiter);
      return { ok: true, data: out };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "PARSE_FAILED", message: (err as Error).message } });
    }
  });

  app.post("/api/connections/:id/import", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    if (conn.readOnly) return reply.code(403).send({ ok: false, error: { code: "READ_ONLY", message: "Connection is read-only" } });
    const { database, table, columns, rows } = parsed.data;
    try {
      const adapter = await getAdapter(id);
      if (adapter.insertRows) {
        const res = await adapter.insertRows(database, table, columns, rows);
        return { ok: true, data: res };
      }
      if (adapter.kind === "redis" || adapter.kind === "dragonfly") {
        return reply.code(400).send({ ok: false, error: { code: "NOT_SUPPORTED", message: "Import into key-value stores is not supported" } });
      }
      // Generic path: literal-quoted multi-row INSERTs in chunks.
      let inserted = 0;
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const res = await adapter.execute(buildMultiInsert(adapter.kind, database, table, columns, slice), { database });
        inserted += res.affectedRows ?? slice.length;
      }
      return { ok: true, data: { inserted } };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "IMPORT_FAILED", message: (err as Error).message } });
    }
  });
}

interface Parsed {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
}

async function parseXlsx(buf: Buffer, limit?: number): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Workbook has no sheets");
  const columns: string[] = [];
  const rows: unknown[][] = [];
  let total = 0;
  ws.eachRow((row, idx) => {
    const values = (row.values as unknown[]).slice(1).map(cellValue);
    if (idx === 1) {
      columns.push(...values.map((v, i) => (v === null || v === undefined || v === "" ? `column${i + 1}` : String(v))));
      return;
    }
    total++;
    if (!limit || rows.length < limit) rows.push(values);
  });
  return { columns, rows, totalRows: total };
}

function cellValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") {
    const o = v as { result?: unknown; text?: string; richText?: { text: string }[]; hyperlink?: string };
    if (o.result !== undefined) return cellValue(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return o.text;
    if (o.hyperlink) return o.hyperlink;
  }
  return v;
}

/** RFC 4180 CSV — handles quoted fields with embedded delimiters/newlines. */
function parseCsv(text: string, limit?: number, delimiter?: string): Parsed {
  const src = text.replace(/^﻿/, "");
  const delim = delimiter || detectDelimiter(src);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let total = 0;
  const pushRecord = () => {
    record.push(field);
    field = "";
    if (record.length === 1 && record[0] === "" ) {
      record = [];
      return;
    }
    if (records.length === 0) records.push(record);
    else {
      total++;
      if (!limit || records.length - 1 < limit) records.push(record);
    }
    record = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      record.push(field);
      field = "";
    } else if (ch === "\n") pushRecord();
    else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      pushRecord();
    } else field += ch;
  }
  if (field !== "" || record.length > 0) pushRecord();
  const header = records[0] ?? [];
  const columns = header.map((h, i) => (h.trim() === "" ? `column${i + 1}` : h.trim()));
  const rows = records.slice(1).map((r) => columns.map((_, i) => (r[i] === undefined || r[i] === "" ? null : r[i])));
  return { columns, rows, totalRows: total };
}

function detectDelimiter(text: string): string {
  const head = text.slice(0, 5000);
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: head.split(d).length }));
  return counts.sort((a, b) => b.n - a.n)[0]!.d;
}
