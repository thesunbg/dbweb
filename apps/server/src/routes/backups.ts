import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteBackupFile, listBackupFiles, listJobs, startBackup, startRestore, toolAvailable, toolsFor } from "../services/backups.js";
import { getConnection } from "../store/connections.js";

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/backups", async (req) => {
    const { connectionId } = req.query as { connectionId?: string };
    const files = listBackupFiles().filter((f) => !connectionId || f.connectionId === connectionId);
    return { ok: true, data: { files, jobs: listJobs(connectionId) } };
  });

  /** Which CLI tools this connection needs and whether they're installed. */
  app.get("/api/connections/:id/backup-tools", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    const tools = toolsFor(conn.kind);
    if (!tools) return { ok: true, data: { supported: false } };
    return {
      ok: true,
      data: {
        supported: true,
        backup: { tool: tools.backup, available: await toolAvailable(tools.backup) },
        restore: { tool: tools.restore, available: await toolAvailable(tools.restore) },
      },
    };
  });

  app.post("/api/connections/:id/backup", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ database: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    try {
      return { ok: true, data: await startBackup(id, parsed.data.database) };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "BACKUP_FAILED", message: (err as Error).message } });
    }
  });

  app.post("/api/connections/:id/restore", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ database: z.string().min(1), file: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    const conn = await getConnection(id);
    if (conn?.readOnly) return reply.code(403).send({ ok: false, error: { code: "READ_ONLY", message: "Connection is read-only" } });
    try {
      return { ok: true, data: await startRestore(id, parsed.data.database, parsed.data.file) };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "RESTORE_FAILED", message: (err as Error).message } });
    }
  });

  app.delete("/api/backups/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    try {
      if (!deleteBackupFile(decodeURIComponent(file))) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "File not found" } });
      return { ok: true, data: { file } };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: (err as Error).message } });
    }
  });
}
