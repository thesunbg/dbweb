import type {
  ApiResult,
  ConnectionConfig,
  ConnectionInput,
  QueryHistoryEntry,
  QueryResultDto,
  SchemaObjectDto,
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
  deleteConnection: (id: string) =>
    request<{ id: string }>(`/api/connections/${id}`, { method: "DELETE" }),

  testConnection: (id: string) =>
    request<PingResult>(`/api/connections/${id}/test`, { method: "POST" }),
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
  execute: (id: string, statement: string, database?: string) =>
    request<QueryResultDto>(`/api/connections/${id}/execute`, {
      method: "POST",
      body: JSON.stringify({ statement, database }),
    }),
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

  exportConfigs: (passphrase: string) =>
    request<{ payload: string; count: number }>("/api/portability/export", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    }),
  importConfigs: (passphrase: string, payload: string) =>
    request<{ imported: number }>("/api/portability/import", {
      method: "POST",
      body: JSON.stringify({ passphrase, payload }),
    }),
};
