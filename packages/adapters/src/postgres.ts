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

/**
 * Postgres pools are tied to a single database. To browse multiple databases
 * we keep a per-database pool cache, lazily creating one the first time the
 * user expands a database in the tree. Each pool reuses the same credentials
 * — only the `database` field changes.
 */
class PostgresAdapter implements DbAdapter {
  readonly kind = "postgres" as const;
  private pools = new Map<string, pg.Pool>();

  constructor(private readonly config: ConnectionConfig) {}

  /** Default DB used for the initial connection / `listDatabases`. */
  private get defaultDatabase(): string {
    return this.config.database || "postgres";
  }

  /**
   * Returns a pool bound to `database`, creating it on first use. The
   * cache key is the lowercased DB name; Postgres identifiers are
   * case-sensitive when quoted but the catalog name we get from
   * pg_database is canonical.
   */
  private getPool(database?: string): pg.Pool {
    const dbName = database || this.defaultDatabase;
    const cached = this.pools.get(dbName);
    if (cached) return cached;
    const pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.username,
      password: this.config.password,
      database: dbName,
      max: 4,
      ...this.config.options,
    });
    this.pools.set(dbName, pool);
    return pool;
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

  /**
   * List all non-template databases the user can see. We deliberately do NOT
   * filter out "postgres" — it's a real database that users frequently put
   * data into (especially in single-tenant setups), and hiding it makes the
   * tree look broken when it's the only DB present.
   */
  async listDatabases(): Promise<SchemaObject[]> {
    const res = await this.getPool().query<{ datname: string }>(
      `SELECT datname FROM pg_database
       WHERE NOT datistemplate
       ORDER BY datname`,
    );
    return res.rows.map((r) => ({ name: r.datname, kind: "database" as const }));
  }

  /**
   * Returns every table/view in every non-system schema of the chosen
   * database. Tables outside the `public` schema are returned with their
   * schema name as a prefix (e.g. `audit.events`) so the tree shows the full
   * qualified name without needing an extra schema folder layer.
   */
  async listObjects(database: string): Promise<SchemaObject[]> {
    const res = await this.getPool(database).query<{
      schema_name: string;
      table_name: string;
      table_type: string;
    }>(
      `SELECT table_schema AS schema_name, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_schema NOT LIKE 'pg_toast%'
         AND table_schema NOT LIKE 'pg_temp%'
       ORDER BY table_schema, table_name`,
    );
    return res.rows.map((r) => ({
      // Qualify with schema only when not the default `public`. Keeps simple
      // "users" tables short while still letting users see `audit.events`.
      name: r.schema_name === "public" ? r.table_name : `${r.schema_name}.${r.table_name}`,
      parent: database,
      kind: r.table_type === "VIEW" ? ("view" as const) : ("table" as const),
      meta: { schema: r.schema_name, rawName: r.table_name },
    }));
  }

  async describeObject(database: string, name: string): Promise<ColumnInfo[]> {
    const { schema, table } = splitQualified(name);
    const res = await this.getPool(database).query<{
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
      [schema, table],
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
    const dbName = database || this.defaultDatabase;
    const res = await this.getPool(dbName).query<{
      relname: string;
      schemaname: string;
      n_live_tup: string;
      total_bytes: string;
    }>(
      `SELECT n.nspname AS schemaname,
              c.relname,
              s.n_live_tup,
              pg_total_relation_size(c.oid) AS total_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE c.relkind = 'r'
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'`,
    );
    const rowEstimates: Record<string, number> = {};
    let totalSize = 0;
    for (const r of res.rows) {
      const key = r.schemaname === "public" ? r.relname : `${r.schemaname}.${r.relname}`;
      rowEstimates[key] = Number(r.n_live_tup ?? 0);
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
    const { schema, table } = splitQualified(change.table);
    const sql = `UPDATE ${quoteIdent(schema)}.${quoteIdent(table)} SET ${setClause} WHERE ${whereClause}`;
    const res = await this.getPool(change.database).query(sql, params);
    return { affectedRows: res.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  }
}

/**
 * Tables coming back from `listObjects` are formatted as `schema.table` for
 * non-public schemas, plain `table` for public. Splitting back lets every
 * downstream call (describe, update, browse) target the right pair.
 */
function splitQualified(name: string): { schema: string; table: string } {
  // Match optional schema. We don't allow a dot inside the schema name itself
  // (Postgres identifiers can technically contain dots if quoted, but the UI
  // never produces such names from listObjects).
  const idx = name.indexOf(".");
  if (idx === -1) return { schema: "public", table: name };
  return { schema: name.slice(0, idx), table: name.slice(idx + 1) };
}

function quoteIdent(name: string): string {
  // Postgres quoting rule: wrap in double quotes, escape embedded ".
  return `"${name.replace(/"/g, '""')}"`;
}

registerAdapter("postgres", (config) => new PostgresAdapter(config));
