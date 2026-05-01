import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api, type ColumnInfoDto } from "../api.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
  table: string;
}

interface Filter {
  column: string;
  op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "IS NULL" | "IS NOT NULL";
  value: string;
}

const QUOTE: Record<ConnectionConfig["kind"], (s: string) => string> = {
  mysql: (s) => "`" + s.replace(/`/g, "``") + "`",
  postgres: (s) => '"' + s.replace(/"/g, '""') + '"',
  oracle: (s) => '"' + s.replace(/"/g, '""') + '"',
  mssql: (s) => "[" + s.replace(/]/g, "]]") + "]",
  mongodb: (s) => s,
  redis: (s) => s,
};

export function TableBrowser({ connection, database, table }: Props) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [limit, setLimit] = useState(100);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});

  const cols = useQuery({
    queryKey: ["cols", connection.id, database, table],
    queryFn: () => api.describeObject(connection.id, database, table),
  });

  const sql = useMemo(() => buildSql(connection.kind, database, table, filters, limit), [
    connection.kind,
    database,
    table,
    filters,
    limit,
  ]);

  const data = useQuery({
    queryKey: ["browse", connection.id, sql],
    queryFn: () => api.execute(connection.id, sql, database),
    enabled: cols.isSuccess,
    refetchOnWindowFocus: false,
  });

  const update = useMutation({
    mutationFn: (payload: {
      primaryKey: Record<string, unknown>;
      changes: Record<string, unknown>;
    }) => api.updateRow(connection.id, { database, table, ...payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["browse", connection.id, sql] });
      setEdits({});
    },
  });

  const pkCols = useMemo(() => cols.data?.filter((c) => c.primaryKey) ?? [], [cols.data]);
  const canEdit = pkCols.length > 0;

  const rowKey = (row: unknown[]) => {
    if (!data.data || pkCols.length === 0) return "";
    const fieldIdx = (name: string) => data.data.fields.indexOf(name);
    return pkCols.map((c) => `${c.name}=${String(row[fieldIdx(c.name)])}`).join("|");
  };

  const onCellEdit = (row: unknown[], col: ColumnInfoDto, newValue: string) => {
    const key = rowKey(row);
    setEdits((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? {}), [col.name]: newValue },
    }));
  };

  const commitRow = (row: unknown[]) => {
    if (!data.data) return;
    const key = rowKey(row);
    const changes = edits[key];
    if (!changes || Object.keys(changes).length === 0) return;
    const fieldIdx = (name: string) => data.data!.fields.indexOf(name);
    const primaryKey: Record<string, unknown> = {};
    for (const c of pkCols) primaryKey[c.name] = row[fieldIdx(c.name)];
    update.mutate({ primaryKey, changes });
  };

  return (
    <div className="browser">
      <div className="browser-toolbar">
        <strong>{database}.{table}</strong>
        {!canEdit && <span className="muted"> · no PK detected, edits disabled</span>}
        {update.isError && (
          <span className="error"> · {(update.error as Error).message}</span>
        )}
        <div className="grow" />
        <label className="inline">
          Limit
          <input
            type="number"
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(10000, Number(e.target.value))))}
            min={1}
            max={10000}
          />
        </label>
        <button type="button" className="ghost" onClick={() => data.refetch()}>
          Reload
        </button>
      </div>

      <FilterBar
        columns={cols.data ?? []}
        filters={filters}
        onChange={setFilters}
      />

      <div className="result-pane">
        {data.isError && <div className="error result-error">{(data.error as Error).message}</div>}
        {data.data && (
          <div className="result-table-wrap">
            <table className="result-table">
              <thead>
                <tr>
                  {data.data.fields.map((f) => {
                    const c = cols.data?.find((x) => x.name === f);
                    return (
                      <th key={f}>
                        {f}
                        {c?.primaryKey && <span className="pk-badge">PK</span>}
                      </th>
                    );
                  })}
                  {canEdit && <th>·</th>}
                </tr>
              </thead>
              <tbody>
                {data.data.rows.map((row, i) => {
                  const key = rowKey(row);
                  const dirty = edits[key] && Object.keys(edits[key]).length > 0;
                  return (
                    <tr key={i} className={dirty ? "dirty" : ""}>
                      {row.map((cell, j) => {
                        const fieldName = data.data!.fields[j]!;
                        const colMeta = cols.data?.find((c) => c.name === fieldName);
                        const isPk = colMeta?.primaryKey ?? false;
                        const editable = canEdit && !isPk && !!colMeta;
                        const editedValue = edits[key]?.[fieldName];
                        const display =
                          editedValue !== undefined ? String(editedValue) : renderCell(cell);
                        return (
                          <td key={j} className={editable ? "editable" : undefined}>
                            {editable ? (
                              <input
                                value={display}
                                onChange={(e) => onCellEdit(row, colMeta!, e.target.value)}
                              />
                            ) : (
                              display
                            )}
                          </td>
                        );
                      })}
                      {canEdit && (
                        <td>
                          <button
                            type="button"
                            className="primary tiny"
                            disabled={!dirty || update.isPending}
                            onClick={() => commitRow(row)}
                          >
                            Save
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface FilterBarProps {
  columns: ColumnInfoDto[];
  filters: Filter[];
  onChange: (next: Filter[]) => void;
}

function FilterBar({ columns, filters, onChange }: FilterBarProps) {
  return (
    <div className="filter-bar">
      {filters.map((f, i) => (
        <div key={i} className="filter-chip">
          <select
            value={f.column}
            onChange={(e) => updateAt(i, { column: e.target.value })}
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={f.op}
            onChange={(e) => updateAt(i, { op: e.target.value as Filter["op"] })}
          >
            {(["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS NULL", "IS NOT NULL"] as const).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          {f.op !== "IS NULL" && f.op !== "IS NOT NULL" && (
            <input
              value={f.value}
              onChange={(e) => updateAt(i, { value: e.target.value })}
              placeholder="value"
            />
          )}
          <button type="button" className="ghost icon" onClick={() => removeAt(i)}>×</button>
        </div>
      ))}
      <button
        type="button"
        className="ghost"
        onClick={() => {
          const first = columns[0];
          if (!first) return;
          onChange([...filters, { column: first.name, op: "=", value: "" }]);
        }}
        disabled={columns.length === 0}
      >
        + filter
      </button>
    </div>
  );

  function updateAt(i: number, patch: Partial<Filter>) {
    onChange(filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removeAt(i: number) {
    onChange(filters.filter((_, idx) => idx !== i));
  }
}

function buildSql(
  kind: ConnectionConfig["kind"],
  database: string,
  table: string,
  filters: Filter[],
  limit: number,
): string {
  const q = QUOTE[kind] ?? ((s: string) => s);
  const parts: string[] = [];
  for (const f of filters) {
    if (f.op === "IS NULL" || f.op === "IS NOT NULL") {
      parts.push(`${q(f.column)} ${f.op}`);
    } else if (f.value !== "") {
      const escaped = f.value.replace(/'/g, "''");
      parts.push(`${q(f.column)} ${f.op} '${escaped}'`);
    }
  }
  const where = parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
  // MSSQL uses TOP, others use LIMIT.
  if (kind === "mssql") {
    return `SELECT TOP ${limit} * FROM ${q(database)}.dbo.${q(table)}${where}`;
  }
  if (kind === "oracle") {
    return `SELECT * FROM ${q(database)}.${q(table)}${where} FETCH FIRST ${limit} ROWS ONLY`;
  }
  if (kind === "postgres") {
    const schema = q(database);
    return `SELECT * FROM ${schema}.${q(table)}${where} LIMIT ${limit}`;
  }
  return `SELECT * FROM ${q(database)}.${q(table)}${where} LIMIT ${limit}`;
}

function renderCell(v: unknown): string {
  if (v === null) return "NULL";
  if (v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
