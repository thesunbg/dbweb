import oracledb, { type Connection, type Pool } from "oracledb";
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

// Default to thin mode — no Oracle Instant Client required. Users can flip
// to thick by setting connection.options.thick = true.
oracledb.fetchAsString = [oracledb.CLOB, oracledb.DATE];

class OracleAdapter implements DbAdapter {
  readonly kind = "oracle" as const;
  private pool: Pool | null = null;
  private static thickInitialized = false;

  constructor(private readonly config: ConnectionConfig) {
    const wantThick = (config.options as { thick?: boolean } | undefined)?.thick;
    if (wantThick && !OracleAdapter.thickInitialized) {
      try {
        oracledb.initOracleClient();
        OracleAdapter.thickInitialized = true;
      } catch (err) {
        throw new Error(
          `Thick mode requires Oracle Instant Client on the system path. ${(err as Error).message}`,
        );
      }
    }
  }

  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;
    const serviceOrSid = this.config.database ?? "XEPDB1";
    this.pool = await oracledb.createPool({
      user: this.config.username,
      password: this.config.password,
      connectString: `${this.config.host}:${this.config.port}/${serviceOrSid}`,
      poolMin: 0,
      poolMax: 4,
      poolIncrement: 1,
    });
    return this.pool;
  }

  private async withConn<T>(
    fn: (c: Connection) => Promise<T>,
  ): Promise<T> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  async connect(): Promise<void> {
    await this.withConn(async (c) => c.execute("SELECT 1 FROM dual"));
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    return this.withConn(async (c) => {
      const start = performance.now();
      const r = await c.execute<[string]>(
        "SELECT banner FROM v$version WHERE ROWNUM = 1",
        [],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      const elapsed = performance.now() - start;
      const v = r.rows?.[0]?.[0];
      return { latencyMs: Math.round(elapsed), serverVersion: v };
    });
  }

  /**
   * In Oracle the closest analogue to a database is a schema (user). We list
   * non-system schemas the current user can see.
   */
  async listDatabases(): Promise<SchemaObject[]> {
    return this.withConn(async (c) => {
      const r = await c.execute<[string]>(
        `SELECT username FROM all_users
         WHERE oracle_maintained = 'N'
         ORDER BY username`,
        [],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (r.rows ?? []).map((row) => ({
        name: row[0],
        kind: "schema" as const,
      }));
    });
  }

  async listObjects(schema: string): Promise<SchemaObject[]> {
    return this.withConn(async (c) => {
      const r = await c.execute<[string, string]>(
        `SELECT object_name, object_type FROM all_objects
         WHERE owner = :owner AND object_type IN ('TABLE','VIEW')
         ORDER BY object_name`,
        { owner: schema },
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (r.rows ?? []).map((row) => ({
        name: row[0],
        parent: schema,
        kind: row[1] === "VIEW" ? ("view" as const) : ("table" as const),
      }));
    });
  }

  async describeObject(schema: string, name: string): Promise<ColumnInfo[]> {
    return this.withConn(async (c) => {
      const r = await c.execute<[string, string, string, string | null, number]>(
        `SELECT c.column_name, c.data_type, c.nullable, c.data_default,
                CASE WHEN cc.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_pk
         FROM all_tab_columns c
         LEFT JOIN (
           SELECT acc.column_name, ac.table_name, ac.owner
           FROM all_constraints ac
           JOIN all_cons_columns acc
             ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner
           WHERE ac.constraint_type = 'P'
         ) cc ON cc.table_name = c.table_name AND cc.owner = c.owner AND cc.column_name = c.column_name
         WHERE c.owner = :owner AND c.table_name = :name
         ORDER BY c.column_id`,
        { owner: schema, name },
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (r.rows ?? []).map((row) => ({
        name: row[0],
        dataType: row[1],
        nullable: row[2] === "Y",
        primaryKey: row[4] === 1,
        default: row[3],
      }));
    });
  }

  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? 1000;
    return this.withConn(async (c) => {
      const start = performance.now();
      const r = await c.execute<unknown[]>(statement, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows: maxRows + 1,
        autoCommit: true,
      });
      const elapsedMs = Math.round(performance.now() - start);

      if (!r.metaData || r.metaData.length === 0) {
        return {
          fields: [],
          rows: [],
          rowCount: 0,
          affectedRows: r.rowsAffected ?? 0,
          elapsedMs,
        };
      }

      const fields = r.metaData.map((m) => m.name);
      const all = (r.rows ?? []) as unknown[][];
      const truncated = all.length > maxRows;
      const rows = truncated ? all.slice(0, maxRows) : all;
      return { fields, rows, rowCount: rows.length, elapsedMs, truncated };
    });
  }

  async getStats(schema?: string): Promise<DbStats> {
    return this.withConn(async (c) => {
      const owner = schema ?? this.config.username?.toUpperCase();
      if (!owner) return {};
      const r = await c.execute<[string, number, number]>(
        `SELECT table_name, num_rows, blocks * 8192 AS size_bytes
         FROM all_tables WHERE owner = :owner`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      const rowEstimates: Record<string, number> = {};
      let totalSize = 0;
      for (const row of r.rows ?? []) {
        rowEstimates[row[0]] = Number(row[1] ?? 0);
        totalSize += Number(row[2] ?? 0);
      }
      return {
        sizeBytes: totalSize,
        tableCount: r.rows?.length ?? 0,
        rowEstimates,
      };
    });
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    await p.close(0);
  }
}

registerAdapter("oracle", (config) => new OracleAdapter(config));
