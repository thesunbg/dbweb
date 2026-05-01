export type DbKind =
  | "mysql"
  | "postgres"
  | "oracle"
  | "mssql"
  | "mongodb"
  | "redis";

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
