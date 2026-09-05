import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSnippet, deleteSnippet, listSnippets, updateSnippet } from "../store/snippets.js";

const kind = z.enum(["mysql", "postgres", "oracle", "mssql", "mongodb", "redis", "dragonfly", "clickhouse"]).nullable().optional();
const input = z.object({ name: z.string().min(1).max(120), statement: z.string().min(1), kind });

export async function snippetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/snippets", async () => ({ ok: true, data: listSnippets() }));

  app.post("/api/snippets", async (req, reply) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    return { ok: true, data: createSnippet(parsed.data) };
  });

  app.patch("/api/snippets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = input.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: "BAD_INPUT", message: parsed.error.message } });
    const out = updateSnippet(id, parsed.data);
    if (!out) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Snippet not found" } });
    return { ok: true, data: out };
  });

  app.delete("/api/snippets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteSnippet(id)) return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Snippet not found" } });
    return { ok: true, data: { id } };
  });
}
