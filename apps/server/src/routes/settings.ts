import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting, setSetting } from "../store/settings.js";
import { DEFAULT_AI_MODEL, resolveApiKey, runAi } from "../services/ai.js";
import { getConnection } from "../store/connections.js";

const settingsSchema = z.object({
  anthropicApiKey: z.string().nullable().optional(),
  aiModel: z.string().min(1).nullable().optional(),
});

const aiSchema = z.object({
  task: z.enum(["generate", "explain", "fix", "optimize"]),
  connectionId: z.string(),
  database: z.string().optional(),
  prompt: z.string().max(8000).optional(),
  statement: z.string().max(20000).optional(),
  error: z.string().max(4000).optional(),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => {
    const key = await resolveApiKey();
    return {
      ok: true,
      data: {
        aiConfigured: !!key,
        aiKeySource: getSetting("anthropicApiKey") ? "settings" : process.env.ANTHROPIC_API_KEY ? "env" : null,
        aiModel: getSetting("aiModel") ?? DEFAULT_AI_MODEL,
      },
    };
  });

  app.put("/api/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    if (parsed.data.anthropicApiKey !== undefined) await setSetting("anthropicApiKey", parsed.data.anthropicApiKey);
    if (parsed.data.aiModel !== undefined) await setSetting("aiModel", parsed.data.aiModel);
    return { ok: true, data: { saved: true } };
  });

  app.post("/api/ai", async (req, reply) => {
    const parsed = aiSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    const conn = await getConnection(parsed.data.connectionId);
    if (!conn) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Connection not found" } });
    try {
      const res = await runAi({ ...parsed.data, kind: conn.kind });
      return { ok: true, data: res };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: { code: "AI_FAILED", message: (err as Error).message } });
    }
  });
}
