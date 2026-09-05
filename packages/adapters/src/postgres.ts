import pg from "pg";
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

/**
 * Postgres pools are tied to a single database. To browse multiple databases
 * we keep a per-database pool cache, lazily creating one the first time the
 * user expands a database in the tree. Each pool reuses the same credentials
 * — only the `database` field changes.
 */
class PostgresAdapter implements DbAdapter {
  readonly kind = "postgres" as const;
  private pools = new Map<string, pg.Pool>();
  /** Explicit transactions: txId → dedicated client holding the session. */
  private txClients = new Map<string, pg.PoolClient>();

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
    // Default cap matches the interactive editor's intent: show a preview,
    // not the whole table. Callers that want more (server export route,
    // explicit `?limit=`) pass `maxRows` explicitly.
    const maxRows = opts.maxRows ?? 50;
    const start = performance.now();
    const res = await this.runQuery(statement, opts);
    const elapsedMs = Math.round(performance.now() - start);

    const isDml = !!res.command && ["INSERT", "UPDATE", "DELETE"].includes(res.command);
    const hasFields = !!res.fields && res.fields.length > 0;

    // DML without RETURNING: no field metadata, just affectedRows.
    if (isDml && !hasFields) {
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
    return {
      fields,
      rows,
      rowCount: limited.length,
      // For DML with RETURNING, surface the server's affected count alongside
      // the returned rows so callers don't have to infer it from rows.length.
      ...(isDml ? { affectedRows: res.rowCount ?? limited.length } : {}),
      elapsedMs,
      truncated,
    };
  }

  /**
   * Routes a statement to the right session: a pinned transaction client,
   * or a pool client that we can cancel via pg_cancel_backend when the
   * caller's AbortSignal fires (the pool query API has no cancel hook).
   */
  private async runQuery(statement: string, opts: ExecuteOptions): Promise<pg.QueryResult> {
    if (opts.transactionId) {
      const tx = this.txClients.get(opts.transactionId);
      if (!tx) throw new Error(`Unknown transaction ${opts.transactionId}`);
      return tx.query(statement);
    }
    const pool = this.getPool(opts.database);
    if (!opts.signal) return pool.query(statement);

    const client = await pool.connect();
    try {
      const pidRes = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = pidRes.rows[0]?.pid;
      const onAbort = () => {
        if (pid) void pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => undefined);
      };
      if (opts.signal.aborted) onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await client.query(statement);
      } finally {
        opts.signal.removeEventListener("abort", onAbort);
      }
    } finally {
      client.release();
    }
  }

  async beginTransaction(txId: string, database?: string): Promise<void> {
    const client = await this.getPool(database).connect();
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release();
      throw err;
    }
    this.txClients.set(txId, client);
  }

  async commitTransaction(txId: string): Promise<void> {
    const client = this.txClients.get(txId);
    if (!client) throw new Error(`Unknown transaction ${txId}`);
    this.txClients.delete(txId);
    try {
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  async rollbackTransaction(txId: string): Promise<void> {
    const client = this.txClients.get(txId);
    if (!client) throw new Error(`Unknown transaction ${txId}`);
    this.txClients.delete(txId);
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }

  async insertRows(database: string, table: string, columns: string[], rows: unknown[][]): Promise<{ inserted: number }> {
    if (rows.length === 0) return { inserted: 0 };
    const { schema, table: tbl } = splitQualified(table);
    const cols = columns.map(quoteIdent).join(", ");
    const pool = this.getPool(database);
    let inserted = 0;
    // Chunk so a 100k-row CSV doesn't become one 100k-parameter statement.
    const chunk = Math.max(1, Math.floor(30000 / Math.max(1, columns.length)));
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const params: unknown[] = [];
      const values = slice
        .map((r) => `(${columns.map((_, c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(", ")})`)
        .join(", ");
      const res = await pool.query(`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(tbl)} (${cols}) VALUES ${values}`, params);
      inserted += res.rowCount ?? slice.length;
    }
    return { inserted };
  }

  async listRelations(database: string): Promise<Relation[]> {
    const res = await this.getPool(database).query<{
      name: string; from_schema: string; from_table: string; from_column: string;
      to_schema: string; to_table: string; to_column: string;
    }>(
      `SELECT con.conname AS name,
              ns.nspname AS from_schema, cl.relname AS from_table, att.attname AS from_column,
              fns.nspname AS to_schema, fcl.relname AS to_table, fatt.attname AS to_column
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_class fcl ON fcl.oid = con.confrelid
       JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
       JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = k.attnum
       JOIN pg_attribute fatt ON fatt.attrelid = fcl.oid AND fatt.attnum = fk.attnum
       WHERE con.contype = 'f'
         AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
       ORDER BY ns.nspname, cl.relname, con.conname, k.ord`,
    );
    const q = (s: string, t: string) => (s === "public" ? t : `${s}.${t}`);
    return res.rows.map((r) => ({
      name: r.name,
      fromTable: q(r.from_schema, r.from_table),
      fromColumn: r.from_column,
      toTable: q(r.to_schema, r.to_table),
      toColumn: r.to_column,
    }));
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
    for (const [id, c] of this.txClients) {
      this.txClients.delete(id);
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
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
