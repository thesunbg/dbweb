import { createClient, type ClickHouseClient } from "@clickhouse/client";
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

interface ChOptions {
  /** Use HTTPS instead of HTTP. Defaults to false. */
  tls?: boolean;
  /** Compression for the request body. Defaults to off. */
  compression?: boolean;
  /** Forces a specific protocol scheme; overrides `tls` when set. */
  protocol?: "http" | "https";
}

class ClickHouseAdapter implements DbAdapter {
  readonly kind = "clickhouse" as const;
  private client: ClickHouseClient | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  /**
   * The official client uses an HTTP URL — we synthesize one from the
   * standard host/port/credentials fields. `options.tls` flips the scheme
   * for self-hosted instances behind TLS terminators (Coolify proxy,
   * Cloudflare, etc.).
   */
  private getClient(): ClickHouseClient {
    if (this.client) return this.client;
    const opts = (this.config.options ?? {}) as ChOptions;
    const protocol = opts.protocol ?? (opts.tls ? "https" : "http");
    const url = `${protocol}://${this.config.host}:${this.config.port}`;
    this.client = createClient({
      url,
      username: this.config.username || "default",
      password: this.config.password ?? "",
      database: this.config.database || "default",
      compression: { request: opts.compression === true, response: false },
      // Defensive: fail fast on dead servers rather than hang the request.
      request_timeout: 30_000,
    });
    return this.client;
  }

  async connect(): Promise<void> {
    const c = this.getClient();
    const ok = await c.ping();
    if (!ok.success) throw ok.error;
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    const start = performance.now();
    const c = this.getClient();
    const res = await c.query({
      query: "SELECT version() AS v",
      format: "JSONEachRow",
    });
    const rows = (await res.json()) as Array<{ v: string }>;
    return {
      latencyMs: Math.round(performance.now() - start),
      serverVersion: rows[0]?.v,
    };
  }

  async listDatabases(): Promise<SchemaObject[]> {
    const c = this.getClient();
    const res = await c.query({
      query:
        "SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name",
      format: "JSONEachRow",
    });
    const rows = (await res.json()) as Array<{ name: string }>;
    return rows.map((r) => ({ name: r.name, kind: "database" as const }));
  }

  async listObjects(database: string): Promise<SchemaObject[]> {
    const c = this.getClient();
    const res = await c.query({
      query: `SELECT name, engine FROM system.tables WHERE database = {db: String} ORDER BY name`,
      query_params: { db: database },
      format: "JSONEachRow",
    });
    const rows = (await res.json()) as Array<{ name: string; engine: string }>;
    return rows.map((r) => ({
      name: r.name,
      parent: database,
      // ClickHouse "views" surface as engines like `View`, `MaterializedView`.
      kind: /view/i.test(r.engine) ? ("view" as const) : ("table" as const),
      meta: { engine: r.engine },
    }));
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const c = this.getClient();
    const res = await c.query({
      query: `SELECT name, type, default_expression, is_in_primary_key
              FROM system.columns
              WHERE database = {db: String} AND table = {tb: String}
              ORDER BY position`,
      query_params: { db: database, tb: name },
      format: "JSONEachRow",
    });
    const rows = (await res.json()) as Array<{
      name: string;
      type: string;
      default_expression: string;
      is_in_primary_key: 0 | 1;
    }>;
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type,
      // ClickHouse encodes nullability inside the type itself (`Nullable(Int32)`).
      nullable: /^Nullable\(/i.test(r.type),
      primaryKey: r.is_in_primary_key === 1,
      default: r.default_expression || null,
    }));
  }

  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    // Default cap matches the interactive editor's intent: show a preview,
    // not the whole table. Callers that want more pass `maxRows` explicitly.
    const maxRows = opts.maxRows ?? 50;
    const c = this.getClient();
    const start = performance.now();

    // Heuristic split: SELECT / SHOW / DESCRIBE / EXISTS / WITH return rows
    // through `query()`; anything else (CREATE / INSERT / ALTER / DROP /
    // OPTIMIZE / TRUNCATE) routes through `command()` which returns no body.
    const head = statement.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    const isReadonly =
      head === "select" ||
      head === "show" ||
      head === "describe" ||
      head === "desc" ||
      head === "explain" ||
      head === "exists" ||
      head === "with";

    if (isReadonly) {
      const res = await c.query({
        query: statement,
        format: "JSONCompactEachRowWithNames",
      });
      const allRows = (await res.json()) as unknown[][];
      const elapsedMs = Math.round(performance.now() - start);
      // The first emitted line is the header, subsequent lines are data.
      const header = (allRows[0] ?? []) as string[];
      const data = allRows.slice(1) as unknown[][];
      const truncated = data.length > maxRows;
      const limited = truncated ? data.slice(0, maxRows) : data;
      return {
        fields: header.map(String),
        rows: limited,
        rowCount: limited.length,
        elapsedMs,
        truncated,
      };
    }

    await c.command({ query: statement });
    const elapsedMs = Math.round(performance.now() - start);
    return {
      fields: [],
      rows: [],
      rowCount: 0,
      // ClickHouse's command() does not return an affected-row count over
      // HTTP; surface 0 to keep the contract while signalling success.
      affectedRows: 0,
      elapsedMs,
    };
  }

  async getStats(database?: string): Promise<DbStats> {
    const c = this.getClient();
    const target = database ?? this.config.database ?? "default";
    const res = await c.query({
      query: `SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes
              FROM system.parts
              WHERE database = {db: String} AND active
              GROUP BY table`,
      query_params: { db: target },
      format: "JSONEachRow",
    });
    const parts = (await res.json()) as Array<{
      table: string;
      rows: string;
      bytes: string;
    }>;
    const rowEstimates: Record<string, number> = {};
    let totalSize = 0;
    for (const r of parts) {
      rowEstimates[r.table] = Number(r.rows);
      totalSize += Number(r.bytes);
    }
    // Even on an empty database we want tableCount to reflect tables that
    // exist but have no parts yet — fall back to system.tables.
    const tblRes = await c.query({
      query: `SELECT count() AS n FROM system.tables WHERE database = {db: String}`,
      query_params: { db: target },
      format: "JSONEachRow",
    });
    const tableCount = Number(((await tblRes.json()) as Array<{ n: string }>)[0]?.n ?? 0);
    return { sizeBytes: totalSize, tableCount, rowEstimates };
  }

  // No `updateRow` — ClickHouse only mutates rows via async `ALTER ... UPDATE`
  // which returns immediately and runs in the background, so there's no
  // meaningful synchronous affected-row count. Leaving the method off lets
  // the route layer return NOT_SUPPORTED, which the UI uses to hide the
  // inline-edit affordance. Power users can still run mutation SQL from the
  // workbench directly.

  async close(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    await c.close();
  }
}

registerAdapter("clickhouse", (config) => new ClickHouseAdapter(config));
