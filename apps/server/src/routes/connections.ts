import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConnectionConfig, DbKind } from "@dbweb/shared-types";
import {
  createConnection,
  deleteConnection,
  duplicateConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../store/connections.js";
import { dropAdapter, getActiveConnectionIds } from "../services/adapter-pool.js";

const dbKindSchema = z.enum([
  "mysql",
  "postgres",
  "oracle",
  "mssql",
  "mongodb",
  "redis",
  "dragonfly",
  "clickhouse",
]);

const connectionInputSchema = z.object({
  name: z.string().min(1),
  kind: dbKindSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  // null moves a connection back to "Ungrouped".
  group: z.string().max(64).nullable().optional(),
  options: z.record(z.unknown()).optional(),
});

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/connections", async () => {
    const items = await listConnections();
    return { ok: true, data: items };
  });

  // Lightweight liveness probe — returns the set of connection IDs that
  // currently have an open adapter in the server-side pool. The UI polls
  // this so each connection in the sidebar can show a "connected" dot
  // without re-running a real ping.
  app.get("/api/connections/active", async () => {
    return { ok: true, data: { ids: getActiveConnectionIds() } };
  });

  app.get("/api/connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    return { ok: true, data: conn };
  });

  // Returns a canonical URL string for this connection, including the
  // decrypted password. Only callable from the local server (we already bind
  // 127.0.0.1) — used by the UI's "Copy as URL" action.
  app.get("/api/connections/:id/url", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await getConnection(id, true);
    if (!conn)
      return reply
        .code(404)
        .send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    return { ok: true, data: { url: buildUrl(conn) } };
  });

  app.post("/api/connections", async (req, reply) => {
    const parsed = connectionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    }
    const conn = await createConnection(parsed.data);
    return { ok: true, data: conn };
  });

  app.post("/api/connections/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await duplicateConnection(id);
    if (!conn)
      return reply
        .code(404)
        .send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
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

const KIND_TO_SCHEME: Record<DbKind, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mongodb: "mongodb",
  redis: "redis",
  mssql: "mssql",
  oracle: "oracle",
  dragonfly: "dragonfly",
  clickhouse: "clickhouse",
};

/**
 * Mirrors the frontend's `buildConnectionUrl` so a connection round-trips
 * losslessly between paste and copy. Lives server-side (not in shared-types)
 * because we need the decrypted password — which the public API never sends
 * to the browser as a separate field.
 */
function buildUrl(c: ConnectionConfig): string {
  const opts = c.options as { uri?: string } | undefined;
  // mongodb+srv URIs are stashed verbatim — they need DNS SRV resolution
  // that simple host/port can't carry.
  if (c.kind === "mongodb" && typeof opts?.uri === "string") return opts.uri;

  const scheme = KIND_TO_SCHEME[c.kind];
  const auth = c.username
    ? `${encodeURIComponent(c.username)}${c.password ? `:${encodeURIComponent(c.password)}` : ""}@`
    : "";
  const port = c.port ? `:${c.port}` : "";
  const dbPath = c.database ? `/${encodeURIComponent(c.database)}` : "";

  const params = new URLSearchParams();
  if (c.options) {
    for (const [k, v] of Object.entries(c.options)) {
      if (k === "uri") continue;
      if (v === undefined || v === null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params.set(k, String(v));
      } else {
        params.set(k, JSON.stringify(v));
      }
    }
  }
  const qs = params.toString() ? `?${params.toString()}` : "";

  return `${scheme}://${auth}${c.host}${port}${dbPath}${qs}`;
}
