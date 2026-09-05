import mysql from "mysql2/promise";
import type { ConnectionConfig } from "@dbweb/shared-types";
import type {
  ColumnInfo,
  DbAdapter,
  DbStats,
  ExecuteOptions,
  QueryResult,
  Relation,
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
  threadId: number;
}

const asQueryable = (c: mysql.PoolConnection): Queryable => c as unknown as Queryable;

class MysqlAdapter implements DbAdapter {
  readonly kind = "mysql" as const;
  private pool: mysql.Pool | null = null;
  /** Explicit transactions: txId → pinned connection. */
  private txConns = new Map<string, Queryable>();

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
      // Alias every column to a lowercase identifier — MySQL 8 returns
      // information_schema column names in upper-case under most builds, so
      // unaliased reads (`r.column_name`) come back as undefined.
      const [rows] = await c.query<Row[]>(
        `SELECT column_name AS col_name,
                data_type AS data_type,
                is_nullable AS is_nullable,
                column_key AS column_key,
                column_default AS column_default
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [database, name],
      );
      return rows.map((r) => ({
        name: r.col_name as string,
        dataType: r.data_type as string,
        nullable: r.is_nullable === "YES",
        primaryKey: r.column_key === "PRI",
        default: (r.column_default as string | null) ?? null,
      }));
    });
  }

  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    // Default cap matches the interactive editor's intent: show a preview,
    // not the whole table. Callers that want more pass `maxRows` explicitly.
    const maxRows = opts.maxRows ?? 50;
    const run = async (c: Queryable) => {
      // Per-call schema switch so the editor runs against whatever the tree
      // has selected. Scoped to this borrowed connection; the pool's default
      // is untouched for callers that don't pass one.
      if (opts.database && !opts.transactionId) {
        await c.query("USE `" + opts.database.replace(/`/g, "``") + "`");
      }
      // Cancellation: KILL QUERY on this thread from another connection.
      const onAbort = () => {
        void this.getPool().query("KILL QUERY ?", [c.threadId]).catch(() => undefined);
      };
      if (opts.signal?.aborted) onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await runOn(c);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
    };
    if (opts.transactionId) {
      const tx = this.txConns.get(opts.transactionId);
      if (!tx) throw new Error(`Unknown transaction ${opts.transactionId}`);
      return run(tx);
    }
    return this.withConn(run);

    async function runOn(c: Queryable): Promise<QueryResult> {
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
    }
  }

  async beginTransaction(txId: string, database?: string): Promise<void> {
    const conn = asQueryable(await this.getPool().getConnection());
    try {
      if (database) await conn.query("USE `" + database.replace(/`/g, "``") + "`");
      await conn.query("START TRANSACTION");
    } catch (err) {
      conn.release();
      throw err;
    }
    this.txConns.set(txId, conn);
  }

  async commitTransaction(txId: string): Promise<void> {
    const conn = this.txConns.get(txId);
    if (!conn) throw new Error(`Unknown transaction ${txId}`);
    this.txConns.delete(txId);
    try {
      await conn.query("COMMIT");
    } finally {
      conn.release();
    }
  }

  async rollbackTransaction(txId: string): Promise<void> {
    const conn = this.txConns.get(txId);
    if (!conn) throw new Error(`Unknown transaction ${txId}`);
    this.txConns.delete(txId);
    try {
      await conn.query("ROLLBACK");
    } finally {
      conn.release();
    }
  }

  async insertRows(database: string, table: string, columns: string[], rows: unknown[][]): Promise<{ inserted: number }> {
    if (rows.length === 0) return { inserted: 0 };
    const q = mysql.escapeId;
    const cols = columns.map((c) => q(c)).join(", ");
    let inserted = 0;
    const chunk = Math.max(1, Math.floor(30000 / Math.max(1, columns.length)));
    await this.withConn(async (c) => {
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const placeholders = slice.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
        const params = slice.flatMap((r) => columns.map((_, idx) => r[idx] ?? null));
        const [res] = await c.query<mysql.ResultSetHeader>(
          `INSERT INTO ${q(database)}.${q(table)} (${cols}) VALUES ${placeholders}`,
          params,
        );
        inserted += (res as mysql.ResultSetHeader).affectedRows;
      }
    });
    return { inserted };
  }

  async listRelations(database: string): Promise<Relation[]> {
    return this.withConn(async (c) => {
      const [rows] = await c.query<Row[]>(
        `SELECT constraint_name AS name, table_name AS from_table, column_name AS from_column,
                referenced_table_name AS to_table, referenced_column_name AS to_column
         FROM information_schema.key_column_usage
         WHERE table_schema = ? AND referenced_table_name IS NOT NULL
         ORDER BY table_name, constraint_name, ordinal_position`,
        [database],
      );
      return rows.map((r) => ({
        name: String(r.name),
        fromTable: String(r.from_table),
        fromColumn: String(r.from_column),
        toTable: String(r.to_table),
        toColumn: String(r.to_column),
      }));
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

      // Alias unprefixed information_schema columns — MySQL 8 returns them
      // upper-cased on most builds, so unaliased reads come back undefined.
      const [rows] = await c.query<Row[]>(
        `SELECT table_name AS tbl_name,
                table_rows AS row_count,
                data_length + index_length AS size_bytes
         FROM information_schema.tables WHERE table_schema = ?`,
        [target],
      );
      const rowEstimates: Record<string, number> = {};
      let totalSize = 0;
      for (const r of rows) {
        rowEstimates[r.tbl_name as string] = Number(r.row_count ?? 0);
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
    for (const [id, c] of this.txConns) {
      this.txConns.delete(id);
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    await p.end();
  }
}

registerAdapter("mysql", (config) => new MysqlAdapter(config));
