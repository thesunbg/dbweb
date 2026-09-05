import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clearAlerts, createSchedule, deleteSchedule, getSchedule, listAlerts, listSchedules, markAlertsRead, updateSchedule } from "../store/schedules.js";
import { runSchedule } from "../services/scheduler.js";

const op = z.enum([">", ">=", "=", "!=", "<", "<="]);
const condition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("error") }),
  z.object({ type: z.literal("rows"), op, value: z.number() }),
  z.object({ type: z.literal("value"), op, value: z.number() }),
]);
const input = z.object({
  connectionId: z.string(),
  database: z.string().optional(),
  name: z.string().min(1).max(120),
  statement: z.string().min(1),
  intervalMin: z.number().int().min(1).max(60 * 24 * 30),
  cron: z.string().max(100).nullable().optional(),
  condition,
  enabled: z.boolean(),
});

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/schedules", async (req) => {
    const { connectionId } = req.query as { connectionId?: string };
    return { ok: true, data: listSchedules(connectionId) };
  });

  app.post("/api/schedules", async (req, reply) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    return { ok: true, data: createSchedule(parsed.data) };
  });

  app.patch("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = input.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    const out = updateSchedule(id, parsed.data);
    if (!out) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Schedule not found" } });
    return { ok: true, data: out };
  });

  app.delete("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteSchedule(id)) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Schedule not found" } });
    return { ok: true, data: { id } };
  });

  app.post("/api/schedules/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = getSchedule(id);
    if (!s) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Schedule not found" } });
    const res = await runSchedule(s);
    return { ok: true, data: { ...res, schedule: getSchedule(id) } };
  });

  app.get("/api/alerts", async () => ({ ok: true, data: listAlerts() }));
  app.post("/api/alerts/read", async (req) => {
    const body = (req.body ?? {}) as { ids?: string[] };
    markAlertsRead(body.ids);
    return { ok: true, data: { read: true } };
  });
  app.delete("/api/alerts", async () => {
    clearAlerts();
    return { ok: true, data: { cleared: true } };
  });
}
