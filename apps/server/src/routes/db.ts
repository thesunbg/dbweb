import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getAdapter, dropAdapter, touchAdapter } from "../services/adapter-pool.js";
import { listHistory, recordQuery } from "../store/history.js";
import { createSaved, deleteSaved, listSaved } from "../store/saved.js";
import { getConnection } from "../store/connections.js";
import { findWriteKeyword } from "../services/sql-guard.js";

const executeSchema = z.object({
  statement: z.string().min(1),
  database: z.string().optional(),
  maxRows: z.number().int().positive().max(50000).optional(),
  /** Client-generated id so the statement can be cancelled mid-flight. */
  requestId: z.string().max(64).optional(),
  transactionId: z.string().max(64).optional(),
});

/** In-flight executes keyed by requestId, for /cancel. */
const inflight = new Map<string, AbortController>();

/** Open transactions: txId → connection, so commit/rollback route correctly
 *  and the pool reaper is told to leave the adapter alone. */
const transactions = new Map<string, { connectionId: string; startedAt: number }>();
setInterval(() => {
  for (const t of transactions.values()) touchAdapter(t.connectionId);
}, 60_000).unref();

/** Shared read-only gate for every write path. */
async function readOnlyBlock(id: string, statement?: string): Promise<string | null> {
  const conn = await getConnection(id);
  if (!conn?.readOnly) return null;
  if (statement === undefined) return "Connection is read-only";
  const kw = findWriteKeyword(conn.kind, statement);
  return kw ? `Connection is read-only — ${kw} is blocked. Turn off "Read-only" in the connection settings to allow writes.` : null;
}

const updateRowSchema = z.object({
  database: z.string().min(1),
  table: z.string().min(1),
  primaryKey: z.record(z.unknown()),
  changes: z.record(z.unknown()),
});

export async function dbRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/connections/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const adapter = await getAdapter(id);
      const ping = await adapter.ping();
      return { ok: true, data: ping };
    } catch (err) {
      await dropAdapter(id).catch(() => undefined);
      return reply.code(400).send({
        ok: false,
        error: { code: "CONNECT_FAILED", message: (err as Error).message },
      });
    }
  });

  app.get("/api/connections/:id/databases", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const adapter = await getAdapter(id);
      const items = await adapter.listDatabases();
      return { ok: true, data: items };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "QUERY_FAILED", message: (err as Error).message },
      });
    }
  });

  app.get("/api/connections/:id/databases/:database/objects", async (req, reply) => {
    const { id, database } = req.params as { id: string; database: string };
    try {
      const adapter = await getAdapter(id);
      const items = await adapter.listObjects(database);
      return { ok: true, data: items };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "QUERY_FAILED", message: (err as Error).message },
      });
    }
  });

  app.get("/api/connections/:id/databases/:database/objects/:name", async (req, reply) => {
    const { id, database, name } = req.params as { id: string; database: string; name: string };
    try {
      const adapter = await getAdapter(id);
      const cols = await adapter.describeObject(database, name);
      return { ok: true, data: cols };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "QUERY_FAILED", message: (err as Error).message },
      });
    }
  });

  app.post("/api/connections/:id/execute", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = executeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }

    const blocked = await readOnlyBlock(id, parsed.data.statement);
    if (blocked) return reply.code(403).send({ ok: false, error: { code: "READ_ONLY", message: blocked } });

    const controller = new AbortController();
    const requestId = parsed.data.requestId;
    if (requestId) inflight.set(requestId, controller);

    let result;
    let error: string | undefined;
    let cancelled = false;
    try {
      const adapter = await getAdapter(id);
      const run = adapter.execute(parsed.data.statement, {
        maxRows: parsed.data.maxRows,
        database: parsed.data.database,
        signal: controller.signal,
        transactionId: parsed.data.transactionId,
      });
      // Adapters that can't interrupt the driver still return promptly: the
      // abort rejects here while the DB finishes on its own.
      const aborted = new Promise<never>((_, rej) => controller.signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true }));
      result = await Promise.race([run, aborted]);
      run.catch(() => undefined);
    } catch (err) {
      error = (err as Error).message;
      cancelled = controller.signal.aborted;
    } finally {
      if (requestId) inflight.delete(requestId);
    }

    recordQuery({
      connectionId: id,
      database: parsed.data.database,
      statement: parsed.data.statement,
      elapsedMs: result?.elapsedMs ?? 0,
      rowCount: result?.rowCount ?? 0,
      error,
    });

    if (error) {
      return reply.code(400).send({ ok: false, error: { code: cancelled ? "CANCELLED" : "EXECUTE_FAILED", message: cancelled ? "Query cancelled" : error } });
    }
    return { ok: true, data: result };
  });

  app.post("/api/connections/:id/cancel", async (req) => {
    const { requestId } = (req.body ?? {}) as { requestId?: string };
    const ctl = requestId ? inflight.get(requestId) : undefined;
    if (ctl) ctl.abort();
    return { ok: true, data: { cancelled: !!ctl } };
  });

  // ---- Explicit transactions -------------------------------------------
  app.post("/api/connections/:id/tx/begin", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { database } = (req.body ?? {}) as { database?: string };
    const blocked = await readOnlyBlock(id);
    if (blocked) return reply.code(403).send({ ok: false, error: { code: "READ_ONLY", message: blocked } });
    try {
      const adapter = await getAdapter(id);
      if (!adapter.beginTransaction) {
        return reply.code(501).send({ ok: false, error: { code: "NOT_SUPPORTED", message: `Explicit transactions are not supported for ${adapter.kind}` } });
      }
      const txId = nanoid(10);
      await adapter.beginTransaction(txId, database);
      transactions.set(txId, { connectionId: id, startedAt: Date.now() });
      return { ok: true, data: { transactionId: txId } };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "TX_FAILED", message: (err as Error).message } });
    }
  });

  for (const action of ["commit", "rollback"] as const) {
    app.post(`/api/connections/:id/tx/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { transactionId } = (req.body ?? {}) as { transactionId?: string };
      if (!transactionId || transactions.get(transactionId)?.connectionId !== id) {
        return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Unknown transaction" } });
      }
      try {
        const adapter = await getAdapter(id);
        if (action === "commit") await adapter.commitTransaction?.(transactionId);
        else await adapter.rollbackTransaction?.(transactionId);
        transactions.delete(transactionId);
        return { ok: true, data: { transactionId } };
      } catch (err) {
        transactions.delete(transactionId);
        return reply.code(400).send({ ok: false, error: { code: "TX_FAILED", message: (err as Error).message } });
      }
    });
  }

  app.get("/api/connections/:id/databases/:database/relations", async (req, reply) => {
    const { id, database } = req.params as { id: string; database: string };
    try {
      const adapter = await getAdapter(id);
      const items = adapter.listRelations ? await adapter.listRelations(database) : [];
      return { ok: true, data: items };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "QUERY_FAILED", message: (err as Error).message } });
    }
  });

  app.get("/api/connections/:id/history", async (req) => {
    const { id } = req.params as { id: string };
    const items = listHistory(id, 200);
    return { ok: true, data: items };
  });

  app.get("/api/connections/:id/stats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { database } = req.query as { database?: string };
    try {
      const adapter = await getAdapter(id);
      const stats = await adapter.getStats(database);
      return { ok: true, data: stats };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "STATS_FAILED", message: (err as Error).message },
      });
    }
  });

  app.post("/api/connections/:id/document", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { database?: string; collection?: string; doc?: Record<string, unknown> };
    if (!body.database || !body.collection || !body.doc) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: "database, collection, doc required" } });
    }
    const blocked = await readOnlyBlock(id);
    if (blocked) return reply.code(403).send({ ok: false, error: { code: "READ_ONLY", message: blocked } });
    try {
      const adapter = await getAdapter(id);
      // We narrow at the route level — only the Mongo adapter implements
      // replaceDocument. SQL adapters use updateRow instead.
      const mongo = adapter as { replaceDocument?: typeof adapter extends never ? never : (db: string, c: string, d: Record<string, unknown>) => Promise<unknown> };
      if (typeof mongo.replaceDocument !== "function") {
        return reply.code(501).send({
          ok: false,
          error: { code: "NOT_SUPPORTED", message: `Document replace not supported for ${adapter.kind}` },
        });
      }
      const res = await mongo.replaceDocument(body.database, body.collection, body.doc);
      return { ok: true, data: res };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "REPLACE_FAILED", message: (err as Error).message },
      });
    }
  });

  app.patch("/api/connections/:id/row", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateRowSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }
    const blocked = await readOnlyBlock(id);
    if (blocked) return reply.code(403).send({ ok: false, error: { code: "READ_ONLY", message: blocked } });
    try {
      const adapter = await getAdapter(id);
      if (!adapter.updateRow) {
        return reply.code(501).send({
          ok: false,
          error: { code: "NOT_SUPPORTED", message: `Inline edit not supported for ${adapter.kind} yet` },
        });
      }
      const result = await adapter.updateRow(parsed.data);
      return { ok: true, data: result };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: "UPDATE_FAILED", message: (err as Error).message },
      });
    }
  });

  app.get("/api/connections/:id/saved", async (req) => {
    const { id } = req.params as { id: string };
    return { ok: true, data: listSaved(id) };
  });

  app.post("/api/connections/:id/saved", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; statement?: string };
    if (!body.name || !body.statement) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: "BAD_INPUT", message: "name and statement required" } });
    }
    return { ok: true, data: createSaved(id, body.name, body.statement) };
  });

  app.delete("/api/saved/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = deleteSaved(id);
    if (!removed)
      return reply
        .code(404)
        .send({ ok: false, error: { code: "NOT_FOUND", message: "Saved query not found" } });
    return { ok: true, data: { id } };
  });

  app.post("/api/connections/:id/disconnect", async (req) => {
    const { id } = req.params as { id: string };
    await dropAdapter(id);
    return { ok: true, data: { id } };
  });
}
