export type DbKind =
  | "mysql"
  | "postgres"
  | "oracle"
  | "mssql"
  | "mongodb"
  | "redis"
  | "dragonfly"
  | "clickhouse";

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  username?: string;
  /** Stored encrypted at rest; never sent to the browser in clear text. */
  password?: string;
  database?: string;
  /** Optional folder the sidebar files this connection under. null/undefined
   *  means "Ungrouped". Groups are derived from this field — there is no
   *  separate group table, so a group exists exactly while something is in it. */
  group?: string | null;
  /** Free-form options per driver (sslMode, authSource, tls, ...). */
  options?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionInput = Omit<
  ConnectionConfig,
  "id" | "createdAt" | "updatedAt"
>;

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  serverVersion?: string;
  error?: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface SchemaObjectDto {
  name: string;
  parent?: string;
  kind: "database" | "schema" | "table" | "view" | "collection" | "key";
  meta?: Record<string, unknown>;
}

export interface QueryResultDto {
  fields: string[];
  rows: unknown[][];
  rowCount: number;
  affectedRows?: number;
  elapsedMs: number;
  truncated?: boolean;
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  database?: string;
  statement: string;
  elapsedMs: number;
  rowCount: number;
  error?: string;
  createdAt: string;
}
