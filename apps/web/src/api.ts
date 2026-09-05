import type {
  AlertDto,
  ApiResult,
  BackupFileDto,
  BackupJobDto,
  ConnectionConfig,
  ConnectionInput,
  QueryHistoryEntry,
  QueryResultDto,
  RelationDto,
  ScheduleDto,
  SchemaObjectDto,
  SnippetDto,
} from "@dbweb/shared-types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only attach JSON content-type when we're actually sending a body — otherwise
  // Fastify rejects body-less POST/PATCH/DELETE with FST_ERR_CTP_EMPTY_JSON_BODY.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined && init.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const res = await fetch(path, { ...init, headers });
  const json = (await res.json()) as ApiResult<T>;
  if (!json.ok) throw new Error(json.error.message);
  return json.data;
}

export type ScheduleInput = Omit<ScheduleDto, "id" | "createdAt" | "lastRunAt" | "lastStatus" | "lastMessage">;

export interface PingResult {
  latencyMs: number;
  serverVersion?: string;
}

export interface ColumnInfoDto {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  default?: string | null;
}

export const api = {
  health: () => request<{ service: string; version: string; time: string }>("/api/health"),

  listConnections: () => request<ConnectionConfig[]>("/api/connections"),
  activeConnections: () => request<{ ids: string[] }>("/api/connections/active"),
  createConnection: (input: ConnectionInput) =>
    request<ConnectionConfig>("/api/connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateConnection: (id: string, patch: Partial<ConnectionInput>) =>
    request<ConnectionConfig>(`/api/connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  duplicateConnection: (id: string) =>
    request<ConnectionConfig>(`/api/connections/${id}/duplicate`, { method: "POST" }),
  deleteConnection: (id: string) =>
    request<{ id: string }>(`/api/connections/${id}`, { method: "DELETE" }),

  testConnection: (id: string) =>
    request<PingResult>(`/api/connections/${id}/test`, { method: "POST" }),
  /** Probe an unsaved form config. Pass `id` while editing so a blank
   *  password falls back to the stored secret. */
  testConfig: (input: ConnectionInput & { id?: string }) =>
    request<PingResult>("/api/connections/test", { method: "POST", body: JSON.stringify(input) }),
  disconnect: (id: string) =>
    request<{ id: string }>(`/api/connections/${id}/disconnect`, { method: "POST" }),
  connectionUrl: (id: string) =>
    request<{ url: string }>(`/api/connections/${id}/url`),
  listDatabases: (id: string) =>
    request<SchemaObjectDto[]>(`/api/connections/${id}/databases`),
  listObjects: (id: string, database: string) =>
    request<SchemaObjectDto[]>(
      `/api/connections/${id}/databases/${encodeURIComponent(database)}/objects`,
    ),
  describeObject: (id: string, database: string, name: string) =>
    request<ColumnInfoDto[]>(
      `/api/connections/${id}/databases/${encodeURIComponent(database)}/objects/${encodeURIComponent(name)}`,
    ),
  execute: (id: string, statement: string, database?: string, maxRows?: number, extra?: { requestId?: string; transactionId?: string }) =>
    request<QueryResultDto>(`/api/connections/${id}/execute`, {
      method: "POST",
      body: JSON.stringify({ statement, database, maxRows, ...extra }),
    }),
  cancel: (id: string, requestId: string) =>
    request<{ cancelled: boolean }>(`/api/connections/${id}/cancel`, { method: "POST", body: JSON.stringify({ requestId }) }),
  txBegin: (id: string, database?: string) =>
    request<{ transactionId: string }>(`/api/connections/${id}/tx/begin`, { method: "POST", body: JSON.stringify({ database }) }),
  txCommit: (id: string, transactionId: string) =>
    request<{ transactionId: string }>(`/api/connections/${id}/tx/commit`, { method: "POST", body: JSON.stringify({ transactionId }) }),
  txRollback: (id: string, transactionId: string) =>
    request<{ transactionId: string }>(`/api/connections/${id}/tx/rollback`, { method: "POST", body: JSON.stringify({ transactionId }) }),
  relations: (id: string, database: string) =>
    request<RelationDto[]>(`/api/connections/${id}/databases/${encodeURIComponent(database)}/relations`),
  history: (id: string) =>
    request<QueryHistoryEntry[]>(`/api/connections/${id}/history`),

  listSaved: (id: string) =>
    request<{ id: string; connectionId: string; name: string; statement: string; createdAt: string }[]>(
      `/api/connections/${id}/saved`,
    ),
  createSaved: (id: string, name: string, statement: string) =>
    request<{ id: string; name: string; statement: string }>(`/api/connections/${id}/saved`, {
      method: "POST",
      body: JSON.stringify({ name, statement }),
    }),
  deleteSaved: (id: string) =>
    request<{ id: string }>(`/api/saved/${id}`, { method: "DELETE" }),
  replaceDocument: (
    id: string,
    payload: { database: string; collection: string; doc: Record<string, unknown> },
  ) =>
    request<{ matchedCount: number; modifiedCount: number }>(
      `/api/connections/${id}/document`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  updateRow: (
    id: string,
    payload: {
      database: string;
      table: string;
      primaryKey: Record<string, unknown>;
      changes: Record<string, unknown>;
    },
  ) =>
    request<{ affectedRows: number }>(`/api/connections/${id}/row`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  stats: (id: string, database?: string) => {
    const qs = database ? `?database=${encodeURIComponent(database)}` : "";
    return request<{
      sizeBytes?: number;
      tableCount?: number;
      rowEstimates?: Record<string, number>;
      extras?: Record<string, unknown>;
    }>(`/api/connections/${id}/stats${qs}`);
  },

  /**
   * Returns a download URL for a table export. The browser handles the actual
   * download via `<a download>` so we don't have to buffer the response in JS
   * memory (which would defeat the point for large dumps).
   */
  exportTableUrl: (
    id: string,
    database: string,
    table: string,
    format: "json" | "csv" | "xlsx",
    limit?: number,
  ) => {
    const params = new URLSearchParams({ database, table, format });
    if (limit) params.set("limit", String(limit));
    return `/api/connections/${id}/export?${params.toString()}`;
  },

  // ---- Settings & AI ----
  settings: () => request<{ aiConfigured: boolean; aiKeySource: "settings" | "env" | null; aiModel: string }>("/api/settings"),
  saveSettings: (patch: { anthropicApiKey?: string | null; aiModel?: string | null }) =>
    request<{ saved: boolean }>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  ai: (body: { task: "generate" | "explain" | "fix" | "optimize"; connectionId: string; database?: string; prompt?: string; statement?: string; error?: string }) =>
    request<{ text: string; code?: string; model: string }>("/api/ai", { method: "POST", body: JSON.stringify(body) }),

  // ---- Snippets ----
  listSnippets: () => request<SnippetDto[]>("/api/snippets"),
  createSnippet: (body: { name: string; statement: string; kind?: SnippetDto["kind"] }) =>
    request<SnippetDto>("/api/snippets", { method: "POST", body: JSON.stringify(body) }),
  updateSnippet: (id: string, body: Partial<{ name: string; statement: string; kind: SnippetDto["kind"] }>) =>
    request<SnippetDto>(`/api/snippets/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSnippet: (id: string) => request<{ id: string }>(`/api/snippets/${id}`, { method: "DELETE" }),

  // ---- Schedules & alerts ----
  listSchedules: (connectionId?: string) =>
    request<ScheduleDto[]>(`/api/schedules${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  createSchedule: (body: ScheduleInput) => request<ScheduleDto>("/api/schedules", { method: "POST", body: JSON.stringify(body) }),
  updateSchedule: (id: string, body: Partial<ScheduleInput>) =>
    request<ScheduleDto>(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSchedule: (id: string) => request<{ id: string }>(`/api/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) =>
    request<{ status: string; message: string; schedule: ScheduleDto }>(`/api/schedules/${id}/run`, { method: "POST" }),
  listAlerts: () => request<AlertDto[]>("/api/alerts"),
  markAlertsRead: (ids?: string[]) => request<{ read: boolean }>("/api/alerts/read", { method: "POST", body: JSON.stringify({ ids }) }),
  clearAlerts: () => request<{ cleared: boolean }>("/api/alerts", { method: "DELETE" }),

  // ---- Backups ----
  listBackups: (connectionId?: string) =>
    request<{ files: BackupFileDto[]; jobs: BackupJobDto[] }>(`/api/backups${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  backupTools: (id: string) =>
    request<{ supported: boolean; backup?: { tool: string; available: boolean }; restore?: { tool: string; available: boolean } }>(`/api/connections/${id}/backup-tools`),
  startBackup: (id: string, database: string) =>
    request<BackupJobDto>(`/api/connections/${id}/backup`, { method: "POST", body: JSON.stringify({ database }) }),
  startRestore: (id: string, database: string, file: string) =>
    request<BackupJobDto>(`/api/connections/${id}/restore`, { method: "POST", body: JSON.stringify({ database, file }) }),
  deleteBackup: (file: string) => request<{ file: string }>(`/api/backups/${encodeURIComponent(file)}`, { method: "DELETE" }),

  // ---- Import ----
  parseImport: (name: string, data: string, limit?: number, delimiter?: string) =>
    request<{ columns: string[]; rows: unknown[][]; totalRows: number }>("/api/import/parse", {
      method: "POST",
      body: JSON.stringify({ name, data, limit, delimiter }),
    }),
  importRows: (id: string, body: { database: string; table: string; columns: string[]; rows: unknown[][] }) =>
    request<{ inserted: number }>(`/api/connections/${id}/import`, { method: "POST", body: JSON.stringify(body) }),

  exportConfigs: (passphrase: string, ids?: string[]) =>
    request<{ payload: string; count: number }>("/api/portability/export", {
      method: "POST",
      body: JSON.stringify(ids ? { passphrase, ids } : { passphrase }),
    }),
  importConfigs: (passphrase: string, payload: string) =>
    request<{ imported: number }>("/api/portability/import", {
      method: "POST",
      body: JSON.stringify({ passphrase, payload }),
    }),
};
