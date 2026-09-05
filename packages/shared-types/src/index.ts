export type DbKind =
  | "mysql"
  | "postgres"
  | "oracle"
  | "mssql"
  | "mongodb"
  | "redis"
  | "dragonfly"
  | "clickhouse";

export type ConnectionColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

/** SSH jump host used to reach the database. Secrets are stripped from
 *  public listings; `hasSecret` tells the form whether one is stored. */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  /** PEM private key contents, or an absolute path to a key file. */
  privateKey?: string;
  passphrase?: string;
  hasSecret?: boolean;
}

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
  /** Optional UI accent (e.g. "red" for production). Purely cosmetic — never
   *  passed to drivers. null/undefined means no accent. */
  color?: ConnectionColor | null;
  /** When true the server refuses INSERT/UPDATE/DELETE/DDL and row edits. */
  readOnly?: boolean;
  ssh?: SshConfig | null;
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

export interface RelationDto {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface SnippetDto {
  id: string;
  name: string;
  statement: string;
  /** Restrict to one engine, or null for all. */
  kind: DbKind | null;
  createdAt: string;
}

export type AlertCondition =
  | { type: "always" }
  | { type: "rows"; op: CompareOp; value: number }
  | { type: "value"; op: CompareOp; value: number }
  | { type: "error" };
export type CompareOp = ">" | ">=" | "=" | "!=" | "<" | "<=";

export interface ScheduleDto {
  id: string;
  connectionId: string;
  database?: string;
  name: string;
  statement: string;
  /** Run every N minutes (ignored when cron is set). */
  intervalMin: number;
  cron?: string | null;
  condition: AlertCondition;
  enabled: boolean;
  lastRunAt?: string | null;
  lastStatus?: "ok" | "error" | "alert" | null;
  lastMessage?: string | null;
  createdAt: string;
}

export interface AlertDto {
  id: string;
  scheduleId: string;
  scheduleName: string;
  connectionId: string;
  message: string;
  createdAt: string;
  read: boolean;
}

export interface BackupJobDto {
  id: string;
  connectionId: string;
  kind: "backup" | "restore";
  database?: string;
  file?: string;
  status: "running" | "done" | "error";
  log: string;
  startedAt: string;
  finishedAt?: string;
}

export interface BackupFileDto {
  file: string;
  sizeBytes: number;
  createdAt: string;
  connectionId?: string;
  connectionName?: string;
  kind?: DbKind;
  database?: string;
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
