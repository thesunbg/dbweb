import mysql from "mysql2/promise";
import type { ConnectionConfig } from "@dbweb/shared-types";
import type {
  ColumnInfo,
  DbAdapter,
  DbStats,
  ExecuteOptions,
  QueryResult,
  RowChange,
  SchemaObject,
} from "./types.js";
import { registerAdapter } from "./registry.js";

type Row = mysql.RowDataPacket;

/**
 * mysql2's promise types declare query/execute on a class returned by a mixin
 * factory; the consumer-side type isn't reachable from `Connection` itself.
 * We narrow the connection through this shape instead of casting to `any`.
 */
interface Queryable {
  query<T extends Row[] | mysql.ResultSetHeader>(
    sql: string,
    values?: unknown[],
  ): Promise<[T, mysql.FieldPacket[]]>;
  ping(): Promise<void>;
  release(): void;
}

const asQueryable = (c: mysql.PoolConnection): Queryable => c as unknown as Queryable;

class MysqlAdapter implements DbAdapter {
  readonly kind = "mysql" as const;
  private pool: mysql.Pool | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  private getPool(): mysql.Pool {
    if (this.pool) return this.pool;
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.username,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 4,
      multipleStatements: false,
      dateStrings: true,
      ...this.config.options,
    });
    return this.pool;
  }

  /**
   * mysql2's promise Pool exposes query through a mixin chain that TS can't
   * statically resolve. Going through getConnection() keeps the call type-safe
   * and ensures we always release the connection back to the pool.
   */
  private async withConn<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    const conn = await this.getPool().getConnection();
    const q = asQueryable(conn);
    try {
      return await fn(q);
    } finally {
      q.release();
    }
  }

  async connect(): Promise<void> {
    await this.withConn((c) => c.ping());
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    return this.withConn(async (c) => {
      const start = performance.now();
      const [rows] = await c.query<Row[]>("SELECT VERSION() AS v");
      const elapsed = performance.now() - start;
      return { latencyMs: Math.round(elapsed), serverVersion: rows[0]?.v as string | undefined };
    });
  }

  async listDatabases(): Promise<SchemaObject[]> {
    return this.withConn(async (c) => {
      const [rows] = await c.query<Row[]>(
        `SELECT schema_name AS name FROM information_schema.schemata
         WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys')
         ORDER BY schema_name`,
      );
      return rows.map((r) => ({ name: r.name as string, kind: "database" as const }));
    });
  }

  async listObjects(database: string): Promise<SchemaObject[]> {
    return this.withConn(async (c) => {
      const [rows] = await c.query<Row[]>(
        `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
         WHERE table_schema = ?
         ORDER BY table_name`,
        [database],
      );
      return rows.map((r) => ({
        name: r.name as string,
        parent: database,
        kind: r.type === "VIEW" ? ("view" as const) : ("table" as const),
      }));
    });
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    return this.withConn(async (c) => {
      const [rows] = await c.query<Row[]>(
        `SELECT column_name, data_type, is_nullable, column_key, column_default
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [database, name],
      );
      return rows.map((r) => ({
        name: r.column_name as string,
        dataType: r.data_type as string,
        nullable: r.is_nullable === "YES",
        primaryKey: r.column_key === "PRI",
        default: (r.column_default as string | null) ?? null,
      }));
    });
  }

  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? 1000;
    return this.withConn(async (c) => {
      const start = performance.now();
      const [result, fields] = await c.query<Row[] | mysql.ResultSetHeader>(statement);
      const elapsedMs = Math.round(performance.now() - start);

      if (Array.isArray(result)) {
        const fieldNames = (fields ?? []).map((f) => f.name);
        const truncated = result.length > maxRows;
        const limited = truncated ? result.slice(0, maxRows) : result;
        const rows = limited.map((r) => fieldNames.map((f) => (r as Record<string, unknown>)[f]));
        return {
          fields: fieldNames,
          rows,
          rowCount: limited.length,
          elapsedMs,
          truncated,
        };
      }

      return {
        fields: [],
        rows: [],
        rowCount: 0,
        affectedRows: result.affectedRows,
        elapsedMs,
      };
    });
  }

  async getStats(database?: string): Promise<DbStats> {
    const target = database ?? this.config.database;
    return this.withConn(async (c) => {
      if (!target) {
        const [rows] = await c.query<Row[]>(
          `SELECT
             SUM(data_length + index_length) AS size_bytes,
             COUNT(*) AS table_count
           FROM information_schema.tables
           WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys')`,
        );
        const r = (rows[0] ?? {}) as Partial<Row>;
        return {
          sizeBytes: r.size_bytes ? Number(r.size_bytes) : undefined,
          tableCount: r.table_count ? Number(r.table_count) : undefined,
        };
      }

      const [rows] = await c.query<Row[]>(
        `SELECT table_name, table_rows, data_length + index_length AS size_bytes
         FROM information_schema.tables WHERE table_schema = ?`,
        [target],
      );
      const rowEstimates: Record<string, number> = {};
      let totalSize = 0;
      for (const r of rows) {
        rowEstimates[r.table_name as string] = Number(r.table_rows ?? 0);
        totalSize += Number(r.size_bytes ?? 0);
      }
      return {
        sizeBytes: totalSize,
        tableCount: rows.length,
        rowEstimates,
      };
    });
  }

  async updateRow(change: RowChange): Promise<{ affectedRows: number }> {
    const q = mysql.escapeId;
    const setKeys = Object.keys(change.changes);
    const pkKeys = Object.keys(change.primaryKey);
    if (setKeys.length === 0) return { affectedRows: 0 };
    if (pkKeys.length === 0) {
      throw new Error("updateRow requires a non-empty primary key");
    }
    const setClause = setKeys.map((k) => `${q(k)} = ?`).join(", ");
    const whereClause = pkKeys.map((k) => `${q(k)} = ?`).join(" AND ");
    const sql = `UPDATE ${q(change.database)}.${q(change.table)} SET ${setClause} WHERE ${whereClause} LIMIT 1`;
    const params = [...setKeys.map((k) => change.changes[k]), ...pkKeys.map((k) => change.primaryKey[k])];
    return this.withConn(async (c) => {
      const [res] = await c.query<mysql.ResultSetHeader>(sql, params);
      return { affectedRows: (res as mysql.ResultSetHeader).affectedRows };
    });
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    await p.end();
  }
}

registerAdapter("mysql", (config) => new MysqlAdapter(config));
