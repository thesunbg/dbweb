import Anthropic from "@anthropic-ai/sdk";
import type { DbKind } from "@dbweb/shared-types";
import { getAdapter } from "./adapter-pool.js";
import { getSecretSetting, getSetting } from "../store/settings.js";

export const DEFAULT_AI_MODEL = "claude-opus-5";

export type AiTask = "generate" | "explain" | "fix" | "optimize";

export interface AiRequest {
  task: AiTask;
  kind: DbKind;
  connectionId: string;
  database?: string;
  /** Natural-language ask (generate) or free-form context. */
  prompt?: string;
  statement?: string;
  error?: string;
}

export interface AiResponse {
  text: string;
  /** First fenced code block, if the answer contained one. */
  code?: string;
  model: string;
}

/** API key from settings (encrypted) or the environment. */
export async function resolveApiKey(): Promise<string | null> {
  return (await getSecretSetting("anthropicApiKey")) ?? process.env.ANTHROPIC_API_KEY ?? null;
}

export function resolveModel(): string {
  return getSetting("aiModel") ?? DEFAULT_AI_MODEL;
}

const schemaCache = new Map<string, { at: number; text: string }>();
const SCHEMA_TTL = 5 * 60 * 1000;
const MAX_TABLES = 60;

/** Compact schema description: one line per table with typed columns. */
export async function schemaContext(connectionId: string, kind: DbKind, database?: string): Promise<string> {
  const key = `${connectionId}/${database ?? ""}`;
  const hit = schemaCache.get(key);
  if (hit && Date.now() - hit.at < SCHEMA_TTL) return hit.text;

  const adapter = await getAdapter(connectionId);
  if (kind === "redis" || kind === "dragonfly") return "(key-value store — no schema)";
  let db = database;
  if (!db) {
    const dbs = await adapter.listDatabases();
    db = dbs[0]?.name;
  }
  if (!db) return "(no database selected)";
  const objects = (await adapter.listObjects(db)).slice(0, MAX_TABLES);
  const lines: string[] = [`database: ${db}`];
  // Describe in small parallel batches — remote DBs with 60 tables would
  // otherwise take a while serially.
  const batch = 6;
  for (let i = 0; i < objects.length; i += batch) {
    const slice = objects.slice(i, i + batch);
    const described = await Promise.all(
      slice.map(async (o) => {
        try {
          const cols = await adapter.describeObject(db!, o.name);
          return `${o.kind === "view" ? "view" : "table"} ${o.name}(${cols.map((c) => `${c.name} ${c.dataType}${c.primaryKey ? " PK" : ""}`).join(", ")})`;
        } catch {
          return `table ${o.name}`;
        }
      }),
    );
    lines.push(...described);
  }
  const text = lines.join("\n");
  schemaCache.set(key, { at: Date.now(), text });
  return text;
}

const DIALECT: Record<DbKind, string> = {
  mysql: "MySQL / MariaDB SQL",
  postgres: "PostgreSQL SQL",
  oracle: "Oracle SQL",
  mssql: "Microsoft SQL Server T-SQL",
  clickhouse: "ClickHouse SQL",
  mongodb: "MongoDB shell (mongosh) statements in the form db.<collection>.<method>(...)",
  redis: "Redis commands, one per line",
  dragonfly: "Redis-compatible commands (Dragonfly), one per line",
};

export async function runAi(req: AiRequest): Promise<AiResponse> {
  const apiKey = await resolveApiKey();
  if (!apiKey) throw new Error("No Anthropic API key configured — add one under Settings (or set ANTHROPIC_API_KEY).");
  const client = new Anthropic({ apiKey });
  const model = resolveModel();

  const schema = await schemaContext(req.connectionId, req.kind, req.database).catch((e: Error) => `(schema unavailable: ${e.message})`);
  const system = [
    `You are a senior database engineer embedded in a database admin tool. Target dialect: ${DIALECT[req.kind]}.`,
    "Answer tersely. When you produce a statement, put it in a single fenced code block (```sql, ```js for MongoDB, ```text for Redis) and add at most two short sentences of explanation after it.",
    "Only reference tables and columns that exist in the schema below unless the user explicitly asks to create new ones. Prefer safe, read-only queries unless the user asks for a modification, and never add a LIMIT the user did not ask for on writes.",
    "",
    "Schema:",
    schema,
  ].join("\n");

  const user = buildUserMessage(req);

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { effort: req.task === "optimize" ? "high" : "medium" },
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`The model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`);
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const code = /```[a-z]*\n([\s\S]*?)```/.exec(text)?.[1]?.trim();
  return { text, code, model };
}

function buildUserMessage(req: AiRequest): string {
  switch (req.task) {
    case "generate":
      return `Write a statement for this request:\n${req.prompt ?? ""}`;
    case "explain":
      return `Explain what this statement does, in plain language, in at most five short bullet points. Mention performance concerns if any.\n\n${req.statement ?? ""}`;
    case "fix":
      return `This statement failed. Explain the cause in one or two sentences, then give a corrected statement.\n\nStatement:\n${req.statement ?? ""}\n\nError:\n${req.error ?? ""}${req.prompt ? `\n\nExtra context: ${req.prompt}` : ""}`;
    case "optimize":
      return `Suggest a faster equivalent of this statement (indexes to add, rewrites). Keep the result set identical. Give the rewritten statement in a code block, then list suggested indexes as separate CREATE INDEX statements if useful.\n\n${req.statement ?? ""}`;
  }
}
