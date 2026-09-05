import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { ResultGrid, type GridSort } from "./ResultGrid.js";
import { downloadText, rowsToCsv, rowsToJson } from "../lib/export.js";
import {
  FILTER_OPS,
  buildCount,
  buildDelete,
  buildInsertTemplate,
  buildSelect,
  buildWhere,
  opNeedsValue,
  rowToInsert,
  type Filter,
} from "../lib/sql.js";
import { confirmDialog, copyText, toast } from "../lib/ui.js";
import { readPref, writePref } from "../lib/prefs.js";

interface Props {
  connection: ConnectionConfig;
  database: string;
  table: string;
  /** Hand a statement to the editor (INSERT template, custom query, …). */
  onOpenInEditor: (statement: string, title?: string) => void;
  onImport?: () => void;
}

const PAGE_SIZES = [50, 100, 200, 500, 1000];

/**
 * Spreadsheet-style table view: server-side paging + sorting + filters,
 * double-click-to-edit cells with a single "Save changes" commit, row
 * delete, and one-click export of the current page or the whole table.
 */
export function TableBrowser({ connection, database, table, onOpenInEditor, onImport }: Props) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [pageSize, setPageSize] = useState<number>(() => readPref("pageSize", 100));
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [edits, setEdits] = useState<Record<number, Record<string, string | null>>>({});
  const [showFilters, setShowFilters] = useState(false);

  const cols = useQuery({
    queryKey: ["cols", connection.id, database, table],
    queryFn: () => api.describeObject(connection.id, database, table),
  });

  const where = useMemo(() => buildWhere(connection.kind, filters), [connection.kind, filters]);
  const sql = useMemo(
    () => buildSelect(connection.kind, database, table, { where, sort, limit: pageSize, offset: page * pageSize }),
    [connection.kind, database, table, where, sort, pageSize, page],
  );
  const countSql = useMemo(() => buildCount(connection.kind, database, table, where), [connection.kind, database, table, where]);

  const data = useQuery({
    queryKey: ["browse", connection.id, sql],
    queryFn: () => api.execute(connection.id, sql, database, pageSize),
    enabled: cols.isSuccess,
    placeholderData: (prev) => prev,
  });
  const count = useQuery({
    queryKey: ["browse-count", connection.id, countSql],
    queryFn: () => api.execute(connection.id, countSql, database, 1),
    enabled: cols.isSuccess,
    staleTime: 60_000,
  });
  const total = count.data ? Number(count.data.rows[0]?.[0] ?? NaN) : NaN;

  // Filters / sort changes restart from page 0 and drop pending edits — the
  // row indexes they pointed at are meaningless once the page changes.
  useEffect(() => {
    setPage(0);
  }, [where, sort, pageSize]);
  useEffect(() => {
    setEdits({});
  }, [sql]);

  const pkCols = useMemo(() => cols.data?.filter((c) => c.primaryKey) ?? [], [cols.data]);
  const canEdit = pkCols.length > 0 && connection.kind !== "clickhouse" && !connection.readOnly;

  const fields = data.data?.fields ?? [];
  const rows = data.data?.rows ?? [];
  const fieldIdx = (name: string) => fields.indexOf(name);
  const pkOf = (row: unknown[]) => Object.fromEntries(pkCols.map((c) => [c.name, row[fieldIdx(c.name)]]));

  const dirtyCount = Object.values(edits).filter((e) => Object.keys(e).length > 0).length;

  const saveAll = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const [idx, changes] of Object.entries(edits)) {
        if (Object.keys(changes).length === 0) continue;
        const row = rows[Number(idx)];
        if (!row) continue;
        await api.updateRow(connection.id, { database, table, primaryKey: pkOf(row), changes });
        n++;
      }
      return n;
    },
    onSuccess: (n) => {
      toast.success(`${n} row${n === 1 ? "" : "s"} updated`);
      setEdits({});
      void qc.invalidateQueries({ queryKey: ["browse", connection.id, sql] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const deleteRow = async (row: unknown[]) => {
    const pk = pkOf(row);
    const desc = Object.entries(pk)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    const ok = await confirmDialog({
      title: "Delete this row?",
      message: `DELETE FROM ${table} WHERE ${desc}. This cannot be undone.`,
      confirmLabel: "Delete row",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.execute(connection.id, buildDelete(connection.kind, database, table, pk), database);
      toast.success(`${res.affectedRows ?? 1} row deleted`);
      void qc.invalidateQueries({ queryKey: ["browse", connection.id] });
      void qc.invalidateQueries({ queryKey: ["browse-count", connection.id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const exportServer = (format: "json" | "csv" | "xlsx") => {
    const a = document.createElement("a");
    a.href = api.exportTableUrl(connection.id, database, table, format);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.info(`Exporting ${table} as ${format.toUpperCase()}…`);
  };

  const pageCount = Number.isFinite(total) ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const from = page * pageSize + 1;
  const to = page * pageSize + rows.length;

  return (
    <div className="browser">
      <div className="browser-toolbar">
        <strong className="browser-title" title={`${database}.${table}`}>
          {table}
        </strong>
        <span className="muted hint">{database}</span>
        {cols.data && (
          <span className="muted hint">
            · {cols.data.length} cols{pkCols.length > 0 ? ` · PK ${pkCols.map((c) => c.name).join(", ")}` : ""}
          </span>
        )}
        {cols.isSuccess && !canEdit && (
          <span className="muted hint" title={connection.readOnly ? "Connection is read-only" : connection.kind === "clickhouse" ? "ClickHouse updates are async" : "Table has no primary key"}>
            · {connection.readOnly ? "🔒 read-only connection" : "read-only"}
          </span>
        )}

        <div className="grow" />

        <button type="button" className={`ghost ${showFilters || filters.length ? "active" : ""}`} onClick={() => setShowFilters((v) => !v)}>
          ⚲ Filter{filters.length ? ` (${filters.length})` : ""}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void data.refetch();
            void count.refetch();
          }}
          title="Reload"
        >
          ⟳
        </button>
        {canEdit && (
          <button type="button" className="ghost" onClick={() => cols.data && onOpenInEditor(buildInsertTemplate(connection.kind, database, table, cols.data), `Insert · ${table}`)} title="Open an INSERT template in the editor">
            + Row
          </button>
        )}
        <button type="button" className="ghost" onClick={() => onOpenInEditor(sql, table)} title="Open this query in the editor">
          ≡ SQL
        </button>
        {onImport && !connection.readOnly && (
          <button type="button" className="ghost" onClick={onImport} title="Import CSV / Excel into this table">
            ↥ Import
          </button>
        )}
        <select
          className="saved-select"
          value=""
          title="Export"
          onChange={(e) => {
            const v = e.target.value;
            if (!data.data) return;
            if (v === "page-csv") downloadText(`${table}-page${page + 1}.csv`, "﻿" + rowsToCsv(fields, rows), "text/csv");
            else if (v === "page-json") downloadText(`${table}-page${page + 1}.json`, rowsToJson(fields, rows), "application/json");
            else if (v === "all-csv") exportServer("csv");
            else if (v === "all-json") exportServer("json");
            else if (v === "all-xlsx") exportServer("xlsx");
          }}
        >
          <option value="">↓ Export…</option>
          <option value="page-csv">This page → CSV</option>
          <option value="page-json">This page → JSON</option>
          <option value="all-csv">Whole table → CSV</option>
          <option value="all-json">Whole table → JSON</option>
          <option value="all-xlsx">Whole table → Excel</option>
        </select>

        {dirtyCount > 0 && (
          <>
            <button type="button" className="ghost" onClick={() => setEdits({})}>
              Discard
            </button>
            <button type="button" className="primary" onClick={() => saveAll.mutate()} disabled={saveAll.isPending}>
              {saveAll.isPending ? "Saving…" : `Save ${dirtyCount} row${dirtyCount === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>

      {showFilters && (
        <FilterBar
          columns={cols.data ?? []}
          filters={filters}
          onChange={setFilters}
          onClose={() => setShowFilters(false)}
        />
      )}

      <div className="result-pane">
        {(data.isError || count.isError) && (
          <div className="error result-error">
            <pre>{((data.error ?? count.error) as Error).message}</pre>
          </div>
        )}
        {data.isLoading && <div className="result-loading">Loading…</div>}
        {data.data && (
          <ResultGrid
            fields={fields}
            rows={rows}
            columns={cols.data}
            sort={sort}
            onSort={(column) =>
              setSort((s) => (!s || s.column !== column ? { column, dir: "asc" } : s.dir === "asc" ? { column, dir: "desc" } : null))
            }
            rowStart={from}
            editable={
              canEdit
                ? {
                    canEditField: (f) => !pkCols.some((c) => c.name === f) && !!cols.data?.some((c) => c.name === f),
                    edits,
                    onEdit: (rowIdx, field, value) =>
                      setEdits((prev) => ({ ...prev, [rowIdx]: { ...(prev[rowIdx] ?? {}), [field]: value } })),
                  }
                : undefined
            }
            rowActions={
              canEdit
                ? (row, rowIdx) => (
                    <span className="row-tight">
                      {edits[rowIdx] && Object.keys(edits[rowIdx]!).length > 0 && (
                        <button
                          type="button"
                          className="ghost icon-btn"
                          title="Discard changes to this row"
                          onClick={() =>
                            setEdits((prev) => {
                              const { [rowIdx]: _drop, ...rest } = prev;
                              return rest;
                            })
                          }
                        >
                          ↶
                        </button>
                      )}
                      <button type="button" className="ghost icon-btn danger" title="Delete row" onClick={() => void deleteRow(row)}>
                        🗑
                      </button>
                    </span>
                  )
                : undefined
            }
            extraMenu={({ rowIdx }) => [
              { label: "Copy row as INSERT", onPick: () => void copyText(rowToInsert(connection.kind, table, fields, rows[rowIdx]!), "INSERT copied") },
              ...(canEdit ? [{ label: "Delete row…", onPick: () => void deleteRow(rows[rowIdx]!), danger: true }] : []),
            ]}
          />
        )}
      </div>

      <div className="pager">
        <span className="muted">
          {rows.length === 0
            ? "No rows"
            : Number.isFinite(total)
              ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`
              : `${from.toLocaleString()}–${to.toLocaleString()}`}
          {data.data && <> · {data.data.elapsedMs}ms</>}
          {data.isFetching && <> · loading…</>}
        </span>
        <div className="grow" />
        <label className="inline hint">
          per page
          <select
            value={pageSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPageSize(v);
              writePref("pageSize", v);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ghost tiny" disabled={page === 0} onClick={() => setPage(0)} title="First page">
          «
        </button>
        <button type="button" className="ghost tiny" disabled={page === 0} onClick={() => setPage((p) => p - 1)} title="Previous page">
          ‹
        </button>
        <span className="hint">
          page {page + 1}
          {pageCount ? ` / ${pageCount}` : ""}
        </span>
        <button
          type="button"
          className="ghost tiny"
          disabled={pageCount ? page + 1 >= pageCount : rows.length < pageSize}
          onClick={() => setPage((p) => p + 1)}
          title="Next page"
        >
          ›
        </button>
        {pageCount && (
          <button type="button" className="ghost tiny" disabled={page + 1 >= pageCount} onClick={() => setPage(pageCount - 1)} title="Last page">
            »
          </button>
        )}
      </div>
    </div>
  );
}

interface FilterBarProps {
  columns: { name: string }[];
  filters: Filter[];
  onChange: (next: Filter[]) => void;
  onClose: () => void;
}

function FilterBar({ columns, filters, onChange, onClose }: FilterBarProps) {
  const updateAt = (i: number, patch: Partial<Filter>) => onChange(filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const removeAt = (i: number) => onChange(filters.filter((_, idx) => idx !== i));
  const add = () => {
    const first = columns[0];
    if (first) onChange([...filters, { column: first.name, op: "=", value: "" }]);
  };

  // Empty filter bar → seed one chip so there's something to type into.
  useEffect(() => {
    if (filters.length === 0 && columns.length > 0) add();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length]);

  return (
    <div className="filter-bar">
      {filters.map((f, i) => (
        <div key={i} className="filter-chip">
          <select value={f.column} onChange={(e) => updateAt(i, { column: e.target.value })}>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={f.op} onChange={(e) => updateAt(i, { op: e.target.value as Filter["op"] })}>
            {FILTER_OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {opNeedsValue(f.op) && (
            <input
              value={f.value}
              onChange={(e) => updateAt(i, { value: e.target.value })}
              placeholder={f.op === "IN" ? "a, b, c" : f.op.includes("LIKE") ? "%text%" : "value"}
              autoFocus={i === filters.length - 1}
            />
          )}
          <button type="button" className="ghost icon-btn" onClick={() => removeAt(i)} title="Remove">
            ×
          </button>
        </div>
      ))}
      <button type="button" className="ghost tiny" onClick={add} disabled={columns.length === 0}>
        + and
      </button>
      <div className="grow" />
      {filters.length > 0 && (
        <button type="button" className="ghost tiny" onClick={() => onChange([])}>
          Clear
        </button>
      )}
      <button type="button" className="ghost icon-btn" onClick={onClose} title="Hide filters">
        ×
      </button>
    </div>
  );
}
