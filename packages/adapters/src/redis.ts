import Redis from "ioredis";
import type { ConnectionConfig } from "@dbweb/shared-types";
import type {
  ColumnInfo,
  DbAdapter,
  DbStats,
  ExecuteOptions,
  QueryResult,
  SchemaObject,
} from "./types.js";
import { registerAdapter } from "./registry.js";

class RedisAdapter implements DbAdapter {
  readonly kind = "redis" as const;
  private client: Redis | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  private getClient(): Redis {
    if (this.client) return this.client;
    this.client = new Redis({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username || undefined,
      password: this.config.password || undefined,
      db: this.config.database ? Number(this.config.database) : 0,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    return this.client;
  }

  async connect(): Promise<void> {
    const c = this.getClient();
    if (c.status === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        c.off("error", onErr);
        resolve();
      };
      const onErr = (err: Error) => {
        c.off("ready", onReady);
        reject(err);
      };
      c.once("ready", onReady);
      c.once("error", onErr);
    });
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    const c = this.getClient();
    await this.connect();
    const start = performance.now();
    await c.ping();
    const elapsed = performance.now() - start;
    const info = await c.info("server");
    const version = /redis_version:(\S+)/.exec(info)?.[1];
    return { latencyMs: Math.round(elapsed), serverVersion: version };
  }

  /** Redis "databases" are numbered slots 0..15 by default. */
  async listDatabases(): Promise<SchemaObject[]> {
    const c = this.getClient();
    await this.connect();
    const info = await c.info("keyspace");
    const slots: SchemaObject[] = [];
    for (let i = 0; i < 16; i++) {
      const m = new RegExp(`db${i}:keys=(\\d+)`).exec(info);
      slots.push({
        name: String(i),
        kind: "database",
        meta: { keys: m ? Number(m[1]) : 0 },
      });
    }
    return slots;
  }

  /**
   * Treat object listing as "scan keys matching a pattern". The `database`
   * argument selects the slot; pattern lives in execute() because it changes
   * per-query.
   */
  async listObjects(database: string): Promise<SchemaObject[]> {
    const c = this.getClient();
    await c.select(Number(database));
    const keys: SchemaObject[] = [];
    let cursor = "0";
    let scanned = 0;
    do {
      const [next, batch] = await c.scan(cursor, "MATCH", "*", "COUNT", 200);
      for (const k of batch) {
        const t = await c.type(k);
        keys.push({ name: k, parent: database, kind: "key", meta: { type: t } });
      }
      cursor = next;
      scanned += batch.length;
      if (scanned >= 500) break;
    } while (cursor !== "0");
    return keys;
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const c = this.getClient();
    await c.select(Number(database));
    const t = await c.type(name);
    const ttl = await c.ttl(name);
    return [
      { name: "type", dataType: t, nullable: false, primaryKey: false },
      { name: "ttl", dataType: ttl >= 0 ? `${ttl}s` : "no expiry", nullable: false, primaryKey: false },
    ];
  }

  /**
   * Statement format: either a Redis command line ("GET foo") or a key dump
   * spec ("KEY foo" → typed read of any key). For `KEY <name>` we route to
   * the right reader so the UI can show appropriate output.
   */
  async execute(statement: string, _opts: ExecuteOptions = {}): Promise<QueryResult> {
    const c = this.getClient();
    await this.connect();
    const start = performance.now();
    const trimmed = statement.trim();

    const keyMatch = /^KEY\s+(.+)$/i.exec(trimmed);
    if (keyMatch) {
      const name = keyMatch[1]!.trim();
      const t = await c.type(name);
      const value = await readKey(c, name, t);
      const elapsedMs = Math.round(performance.now() - start);
      const rows = Array.isArray(value)
        ? value.map((v, i) => [String(i), JSON.stringify(v)])
        : value && typeof value === "object"
          ? Object.entries(value).map(([k, v]) => [k, JSON.stringify(v)])
          : [["value", JSON.stringify(value)]];
      return {
        fields: ["key", "value"],
        rows,
        rowCount: rows.length,
        elapsedMs,
      };
    }

    const parts = parseCommand(trimmed);
    if (parts.length === 0) throw new Error("Empty Redis command");
    const cmd = parts[0]!.toLowerCase();
    if (BLOCKED_COMMANDS.has(cmd)) {
      throw new Error(`Command "${cmd}" is blocked from the workbench`);
    }
    // ioredis exposes every command as a lowercase method on the client.
    const fn = (c as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[cmd];
    if (typeof fn !== "function") throw new Error(`Unknown Redis command: ${cmd}`);
    const reply = await fn.apply(c, parts.slice(1));
    const elapsedMs = Math.round(performance.now() - start);
    const rows: unknown[][] = Array.isArray(reply)
      ? reply.map((v, i) => [i, formatReply(v)])
      : [["", formatReply(reply)]];
    return {
      fields: Array.isArray(reply) ? ["#", "value"] : ["", "value"],
      rows,
      rowCount: rows.length,
      elapsedMs,
    };
  }

  async getStats(): Promise<DbStats> {
    const c = this.getClient();
    await this.connect();
    const info = await c.info("memory");
    const used = /used_memory:(\d+)/.exec(info)?.[1];
    return {
      sizeBytes: used ? Number(used) : undefined,
      extras: { info: info.split("\n").slice(0, 8).join("\n") },
    };
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    await c.quit().catch(() => undefined);
  }
}

const BLOCKED_COMMANDS = new Set(["flushall", "flushdb", "shutdown", "config", "debug"]);

async function readKey(c: Redis, name: string, type: string): Promise<unknown> {
  switch (type) {
    case "string":
      return c.get(name);
    case "hash":
      return c.hgetall(name);
    case "list":
      return c.lrange(name, 0, 999);
    case "set":
      return c.smembers(name);
    case "zset":
      return c.zrange(name, 0, 999, "WITHSCORES");
    case "stream":
      return c.xrange(name, "-", "+", "COUNT", 100);
    default:
      return null;
  }
}

function parseCommand(input: string): string[] {
  // Quoted-aware split — preserves "string with spaces".
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function formatReply(v: unknown): string {
  if (v === null || v === undefined) return "(nil)";
  if (Buffer.isBuffer(v)) return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

registerAdapter("redis", (config) => new RedisAdapter(config));
