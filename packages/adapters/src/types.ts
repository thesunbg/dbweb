import type { ConnectionConfig, DbKind } from "@dbweb/shared-types";

export interface SchemaObject {
  name: string;
  /** Optional parent (e.g. schema for tables, db for collections). */
  parent?: string;
  kind: "database" | "schema" | "table" | "view" | "collection" | "key";
  meta?: Record<string, unknown>;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  default?: string | null;
}

export interface QueryResult {
  /** Field names in the order returned. Empty for write-only statements. */
  fields: string[];
  rows: unknown[][];
  rowCount: number;
  /** Server-reported affected rows for DML, where applicable. */
  affectedRows?: number;
  /** Total wall-clock time in ms, measured by the adapter. */
  elapsedMs: number;
  /** Truncation flag when the adapter caps result size. */
  truncated?: boolean;
}

export interface ExecuteOptions {
  /** Caller-controlled cap to prevent runaway results. */
  maxRows?: number;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
  /** Transactional context if the driver supports it. */
  transactionId?: string;
}

export interface DbStats {
  sizeBytes?: number;
  tableCount?: number;
  rowEstimates?: Record<string, number>;
  /** Adapter-specific extras (uptime, version, ...). */
  extras?: Record<string, unknown>;
}

export interface RowChange {
  database: string;
  table: string;
  /** column → value map identifying the row. Must match a unique row. */
  primaryKey: Record<string, unknown>;
  /** column → new value map of fields to update. */
  changes: Record<string, unknown>;
}

/**
 * The single contract every database integration implements.
 * Keep this minimal — adapter-specific operations belong in subtypes
 * (SqlAdapter, MongoAdapter, RedisAdapter) layered on top.
 */
export interface DbAdapter {
  readonly kind: DbKind;
  connect(): Promise<void>;
  ping(): Promise<{ latencyMs: number; serverVersion?: string }>;
  listDatabases(): Promise<SchemaObject[]>;
  listObjects(database: string): Promise<SchemaObject[]>;
  describeObject(database: string, name: string): Promise<ColumnInfo[]>;
  execute(statement: string, opts?: ExecuteOptions): Promise<QueryResult>;
  getStats(database?: string): Promise<DbStats>;
  /** Optional — adapters that don't support parameterized writes throw. */
  updateRow?(change: RowChange): Promise<{ affectedRows: number }>;
  close(): Promise<void>;
}

export type AdapterFactory = (config: ConnectionConfig) => DbAdapter;
