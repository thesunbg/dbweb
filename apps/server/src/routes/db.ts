import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter, dropAdapter } from "../services/adapter-pool.js";
import { listHistory, recordQuery } from "../store/history.js";
import { createSaved, deleteSaved, listSaved } from "../store/saved.js";

const executeSchema = z.object({
  statement: z.string().min(1),
  database: z.string().optional(),
  maxRows: z.number().int().positive().max(50000).optional(),
});

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

    let result;
    let error: string | undefined;
    try {
      const adapter = await getAdapter(id);
      // Future: per-call USE database. For now we rely on the pool's default db.
      result = await adapter.execute(parsed.data.statement, { maxRows: parsed.data.maxRows });
    } catch (err) {
      error = (err as Error).message;
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
      return reply.code(400).send({ ok: false, error: { code: "EXECUTE_FAILED", message: error } });
    }
    return { ok: true, data: result };
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
