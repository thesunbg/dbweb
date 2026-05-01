import pg from "pg";
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

class PostgresAdapter implements DbAdapter {
  readonly kind = "postgres" as const;
  private pool: pg.Pool | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  private getPool(): pg.Pool {
    if (this.pool) return this.pool;
    this.pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.username,
      password: this.config.password,
      database: this.config.database ?? "postgres",
      max: 4,
      ...this.config.options,
    });
    return this.pool;
  }

  async connect(): Promise<void> {
    const c = await this.getPool().connect();
    c.release();
  }

  async ping(): Promise<{ latencyMs: number; serverVersion?: string }> {
    const start = performance.now();
    const res = await this.getPool().query<{ version: string }>("SELECT version() AS version");
    const elapsed = performance.now() - start;
    return { latencyMs: Math.round(elapsed), serverVersion: res.rows[0]?.version };
  }

  async listDatabases(): Promise<SchemaObject[]> {
    const res = await this.getPool().query<{ datname: string }>(
      `SELECT datname FROM pg_database
       WHERE NOT datistemplate AND datname NOT IN ('postgres')
       ORDER BY datname`,
    );
    return res.rows.map((r) => ({ name: r.datname, kind: "database" as const }));
  }

  /**
   * Postgres pools are tied to one database. To browse a different one we'd
   * need a separate pool — for Phase 2 we only browse the configured database
   * and treat the param as the schema instead.
   */
  async listObjects(database: string): Promise<SchemaObject[]> {
    const targetSchema = database === this.config.database ? "public" : database;
    const res = await this.getPool().query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [targetSchema],
    );
    return res.rows.map((r) => ({
      name: r.table_name,
      parent: targetSchema,
      kind: r.table_type === "VIEW" ? ("view" as const) : ("table" as const),
    }));
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const targetSchema = database === this.config.database ? "public" : database;
    const res = await this.getPool().query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_pk: boolean;
    }>(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              EXISTS(
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND tc.constraint_type = 'PRIMARY KEY'
                  AND kcu.column_name = c.column_name
              ) AS is_pk
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [targetSchema, name],
    );
    return res.rows.map((r) => ({
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      primaryKey: r.is_pk,
      default: r.column_default,
    }));
  }

  async execute(statement: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? 1000;
    const start = performance.now();
    const res = await this.getPool().query(statement);
    const elapsedMs = Math.round(performance.now() - start);

    if (res.command && ["INSERT", "UPDATE", "DELETE"].includes(res.command)) {
      return {
        fields: [],
        rows: [],
        rowCount: 0,
        affectedRows: res.rowCount ?? 0,
        elapsedMs,
      };
    }

    const fields = res.fields.map((f) => f.name);
    const truncated = res.rows.length > maxRows;
    const limited = truncated ? res.rows.slice(0, maxRows) : res.rows;
    const rows = limited.map((r) =>
      fields.map((f) => (r as Record<string, unknown>)[f]),
    );
    return { fields, rows, rowCount: limited.length, elapsedMs, truncated };
  }

  async getStats(database?: string): Promise<DbStats> {
    const targetSchema = !database || database === this.config.database ? "public" : database;
    const res = await this.getPool().query<{
      relname: string;
      n_live_tup: string;
      total_bytes: string;
    }>(
      `SELECT c.relname,
              s.n_live_tup,
              pg_total_relation_size(c.oid) AS total_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE n.nspname = $1 AND c.relkind = 'r'`,
      [targetSchema],
    );
    const rowEstimates: Record<string, number> = {};
    let totalSize = 0;
    for (const r of res.rows) {
      rowEstimates[r.relname] = Number(r.n_live_tup ?? 0);
      totalSize += Number(r.total_bytes ?? 0);
    }
    return {
      sizeBytes: totalSize,
      tableCount: res.rows.length,
      rowEstimates,
    };
  }

  async updateRow(change: RowChange): Promise<{ affectedRows: number }> {
    const setKeys = Object.keys(change.changes);
    const pkKeys = Object.keys(change.primaryKey);
    if (setKeys.length === 0) return { affectedRows: 0 };
    if (pkKeys.length === 0) {
      throw new Error("updateRow requires a non-empty primary key");
    }
    const params: unknown[] = [];
    const setClause = setKeys
      .map((k) => {
        params.push(change.changes[k]);
        return `${quoteIdent(k)} = $${params.length}`;
      })
      .join(", ");
    const whereClause = pkKeys
      .map((k) => {
        params.push(change.primaryKey[k]);
        return `${quoteIdent(k)} = $${params.length}`;
      })
      .join(" AND ");
    const schema = change.database === this.config.database ? "public" : change.database;
    const sql = `UPDATE ${quoteIdent(schema)}.${quoteIdent(change.table)} SET ${setClause} WHERE ${whereClause}`;
    const res = await this.getPool().query(sql, params);
    return { affectedRows: res.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    await p.end();
  }
}

function quoteIdent(name: string): string {
  // Postgres quoting rule: wrap in double quotes, escape embedded ".
  return `"${name.replace(/"/g, '""')}"`;
}

registerAdapter("postgres", (config) => new PostgresAdapter(config));
