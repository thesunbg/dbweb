import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../store/connections.js";
import { dropAdapter } from "../services/adapter-pool.js";

const dbKindSchema = z.enum(["mysql", "postgres", "oracle", "mssql", "mongodb", "redis"]);

const connectionInputSchema = z.object({
  name: z.string().min(1),
  kind: dbKindSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/connections", async () => {
    const items = await listConnections();
    return { ok: true, data: items };
  });

  app.get("/api/connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    return { ok: true, data: conn };
  });

  app.post("/api/connections", async (req, reply) => {
    const parsed = connectionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }
    const conn = await createConnection(parsed.data);
    return { ok: true, data: conn };
  });

  app.patch("/api/connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = connectionInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }
    const conn = await updateConnection(id, parsed.data);
    if (!conn) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    // Drop the cached adapter so the next call re-creates with new config.
    await dropAdapter(id);
    return { ok: true, data: conn };
  });

  app.delete("/api/connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await dropAdapter(id);
    const removed = deleteConnection(id);
    if (!removed) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    return { ok: true, data: { id } };
  });
}
