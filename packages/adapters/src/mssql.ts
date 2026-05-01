import { Connection, Request, TYPES } from "tedious";
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

interface ColumnMeta {
  metadata: { colName: string };
  value: unknown;
}

class MssqlAdapter implements DbAdapter {
  readonly kind = "mssql" as const;
  private connection: Connection | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  /**
   * tedious doesn't ship a built-in pool. For Phase 2 we keep one logical
   * connection per adapter — the workbench is single-user so this is fine.
   * If contention shows up we can swap to `mssql` (which wraps tedious + pool).
   */
  private async getConn(): Promise<Connection> {
    if (this.connection) return this.connection;
    if (this.connecting) {
      await this.connecting;
      return this.connection!;
    }
    this.connecting = new Promise<void>((resolve, reject) => {
      const conn = new Connection({
        server: this.config.host,
        options: {
          port: this.config.port,
          database: this.config.database,
          trustServerCertificate: true,
          encrypt: true,
          rowCollectionOnRequestCompletion: true,
          ...(this.config.options as object | undefined),
        },
        authentication: {
          type: "default",
          options: { userName: this.config.username, password: this.config.password },
        },
      });
      conn.on("connect", (err) => {
        if (err) {
          this.connecting = null;
          reject(err);
          return;
        }
        this.connection = conn;
        this.connecting = null;
        resolve();
      });
      conn.on("error", (err) => {
        // Surface late errors to anyone awaiting; future calls will reconnect.
        this.connection = null;
        if (this.connecting) {
          this.connecting = null;
          reject(err);
        }
      });
      conn.connect();
    });
    await this.connecting;
    return this.connection!;
  }

  private async runQuery(sql: string): Promise<{
    rows: ColumnMeta[][];
    rowCount: number;
  }> {
    const conn = await this.getConn();
    return new Promise((resolve, reject) => {
      const rows: ColumnMeta[][] = [];
      const req = new Request(sql, (err, rowCount) => {
        if (err) reject(err);
        else resolve({ rows, rowCount: rowCount ?? 0 });
      });
      req.on("row", (columns) => rows.push(columns as unknown as ColumnMeta[]));
      conn.execSql(req);
    });
  }

  async connect(): Promise<void> {
    await this.getConn();
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    const start = performance.now();
    const res = await this.runQuery("SELECT @@VERSION AS v");
    const elapsed = performance.now() - start;
    const v = res.rows[0]?.[0]?.value;
    return { latencyMs: Math.round(elapsed), serverVersion: typeof v === "string" ? v : undefined };
  }

  async listDatabases(): Promise<SchemaObject[]> {
    const res = await this.runQuery(
      `SELECT name FROM sys.databases
       WHERE name NOT IN ('master','tempdb','model','msdb')
       ORDER BY name`,
    );
    return res.rows.map((r) => ({
      name: String(r[0]?.value ?? ""),
      kind: "database" as const,
    }));
  }

  async listObjects(database: string): Promise<SchemaObject[]> {
    const safe = database.replace(/[^\w]/g, "");
    const res = await this.runQuery(
      `SELECT TABLE_NAME, TABLE_TYPE FROM [${safe}].INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`,
    );
    return res.rows.map((r) => ({
      name: String(r[0]?.value ?? ""),
      parent: database,
      kind: r[1]?.value === "VIEW" ? ("view" as const) : ("table" as const),
    }));
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const safe = database.replace(/[^\w]/g, "");
    const safeName = name.replace(/'/g, "''");
    const res = await this.runQuery(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              CASE WHEN EXISTS (
                SELECT 1 FROM [${safe}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN [${safe}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                  ON tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                  AND tc.TABLE_NAME = c.TABLE_NAME
                  AND k.COLUMN_NAME = c.COLUMN_NAME
              ) THEN 1 ELSE 0 END AS is_pk
       FROM [${safe}].INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_NAME = '${safeName}'
       ORDER BY c.ORDINAL_POSITION`,
    );
    return res.rows.map((r) => ({
      name: String(r[0]?.value ?? ""),
      dataType: String(r[1]?.value ?? ""),
      nullable: r[2]?.value === "YES",
      primaryKey: Number(r[4]?.value ?? 0) === 1,
      default: (r[3]?.value as string | null | undefined) ?? null,
    }));
  }

  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? 1000;
    const start = performance.now();
    const res = await this.runQuery(statement);
    const elapsedMs = Math.round(performance.now() - start);

    if (res.rows.length === 0) {
      return { fields: [], rows: [], rowCount: 0, affectedRows: res.rowCount, elapsedMs };
    }

    const fields = res.rows[0]!.map((c) => c.metadata.colName);
    const truncated = res.rows.length > maxRows;
    const limited = truncated ? res.rows.slice(0, maxRows) : res.rows;
    const rows = limited.map((r) => r.map((c) => c.value));
    return { fields, rows, rowCount: limited.length, elapsedMs, truncated };
  }

  async getStats(): Promise<DbStats> {
    // Cheap stub for Phase 2; full sys.partitions roll-up can come later.
    const res = await this.runQuery(
      `SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`,
    );
    return { tableCount: Number(res.rows[0]?.[0]?.value ?? 0) };
  }

  async close(): Promise<void> {
    if (!this.connection) return;
    const c = this.connection;
    this.connection = null;
    return new Promise<void>((resolve) => {
      c.on("end", () => resolve());
      c.close();
    });
  }
}

// Reference TYPES to keep tedious from being shaken — adapter currently
// uses raw SQL but we'll need parameterized queries for inline edit.
void TYPES;

registerAdapter("mssql", (config) => new MssqlAdapter(config));
