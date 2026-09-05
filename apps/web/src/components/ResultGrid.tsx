import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import type { ColumnInfoDto } from "../api.js";
import { rowsToCsv } from "../lib/export.js";
import { Modal, copyText } from "../lib/ui.js";
import { useTheme } from "../lib/theme.js";
import { shortType } from "../lib/format.js";

export interface GridSort {
  column: string;
  dir: "asc" | "desc";
}

interface EditableConfig {
  /** Which fields accept edits (PK columns usually don't). */
  canEditField: (field: string) => boolean;
  /** Pending edits keyed by row index → field → new value. */
  edits: Record<number, Record<string, string | null>>;
  onEdit: (rowIdx: number, field: string, value: string | null) => void;
}

interface Props {
  fields: string[];
  rows: unknown[][];
  /** Optional column metadata — enables PK badges + type tooltips. */
  columns?: ColumnInfoDto[];
  /** Server-side sort state; when `onSort` is absent the grid sorts locally. */
  sort?: GridSort | null;
  onSort?: (column: string) => void;
  /** 1-based number of the first row (pagination offset). */
  rowStart?: number;
  editable?: EditableConfig;
  /** Rendered as the last column per row (Save / Delete / …). */
  rowActions?: (row: unknown[], rowIdx: number) => ReactNode;
  /** Rendered as the first column per row (e.g. Mongo edit icon). */
  rowLead?: (row: unknown[], rowIdx: number) => ReactNode;
  /** Extra context-menu entries per cell. */
  extraMenu?: (ctx: { rowIdx: number; field: string; value: unknown }) => { label: string; onPick: () => void; danger?: boolean }[];
  compact?: boolean;
}

interface CellPos {
  row: number;
  col: number;
}

/**
 * The one table component every result surface renders through. Handles
 * the things a bare <table> got wrong: row numbers, NULL styling, sticky
 * header, sort affordances, a value inspector for truncated cells, and a
 * right-click menu with the copy actions people reach for constantly.
 */
export function ResultGrid({
  fields,
  rows,
  columns,
  sort,
  onSort,
  rowStart = 1,
  editable,
  rowActions,
  rowLead,
  extraMenu,
  compact,
}: Props) {
  const [selected, setSelected] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<CellPos | null>(null);
  const [localSort, setLocalSort] = useState<GridSort | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; pos: CellPos } | null>(null);
  const [viewer, setViewer] = useState<{ field: string; value: unknown } | null>(null);
  const [wrap, setWrap] = useState(false);

  // Reset selection when the data set changes shape (new query).
  useEffect(() => {
    setSelected(null);
    setEditing(null);
    setLocalSort(null);
  }, [fields]);

  const effectiveSort = onSort ? (sort ?? null) : localSort;

  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (onSort || !localSort) return idx;
    const col = fields.indexOf(localSort.column);
    if (col === -1) return idx;
    const dir = localSort.dir === "asc" ? 1 : -1;
    return idx.sort((a, b) => compareCells(rows[a]![col], rows[b]![col]) * dir);
  }, [rows, fields, localSort, onSort]);

  const colMeta = (f: string) => columns?.find((c) => c.name === f);

  const clickHeader = (f: string) => {
    if (onSort) return onSort(f);
    setLocalSort((s) => {
      if (!s || s.column !== f) return { column: f, dir: "asc" };
      if (s.dir === "asc") return { column: f, dir: "desc" };
      return null;
    });
  };

  const valueAt = (pos: CellPos) => {
    const rowIdx = order[pos.row]!;
    const field = fields[pos.col]!;
    const edited = editable?.edits[rowIdx]?.[field];
    return edited !== undefined ? edited : rows[rowIdx]![pos.col];
  };

  const rowObject = (rowIdx: number) => Object.fromEntries(fields.map((f, i) => [f, rows[rowIdx]![i]]));

  // Keyboard: arrows move the selection, Enter opens the inspector /
  // starts editing, Escape clears. Only active while the grid has focus.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!selected || editing) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setSelected({
        row: Math.max(0, Math.min(rows.length - 1, selected.row + dr)),
        col: Math.max(0, Math.min(fields.length - 1, selected.col + dc)),
      });
    };
    if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowLeft") move(0, -1);
    else if (e.key === "ArrowRight") move(0, 1);
    else if (e.key === "Escape") setSelected(null);
    else if (e.key === "Enter") {
      e.preventDefault();
      const field = fields[selected.col]!;
      if (editable?.canEditField(field)) setEditing(selected);
      else setViewer({ field, value: valueAt(selected) });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copyText(cellText(valueAt(selected)), "Cell copied");
    }
  };

  const selectedValue = selected ? valueAt(selected) : undefined;
  const selectedField = selected ? fields[selected.col] : undefined;

  return (
    <div className="grid-shell">
      <div className="grid-scroll" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
        <table className={`result-table ${compact ? "compact" : ""} ${wrap ? "wrap" : ""}`}>
          <thead>
            <tr>
              <th className="rownum-col">#</th>
              {rowLead && <th className="action-col" />}
              {fields.map((f) => {
                const meta = colMeta(f);
                const active = effectiveSort?.column === f;
                return (
                  <th
                    key={f}
                    className={`sortable ${active ? "sorted" : ""}`}
                    onClick={() => clickHeader(f)}
                    title={meta ? `${meta.dataType}${meta.nullable ? " · nullable" : ""}${meta.primaryKey ? " · primary key" : ""} — click to sort` : "Click to sort"}
                  >
                    <span className="th-label">{f}</span>
                    {meta?.primaryKey && <span className="pk-badge">PK</span>}
                    {meta && <span className="th-type">{shortType(meta.dataType)}</span>}
                    <span className="sort-ind">{active ? (effectiveSort!.dir === "asc" ? "▲" : "▼") : ""}</span>
                  </th>
                );
              })}
              {rowActions && <th className="action-col" />}
            </tr>
          </thead>
          <tbody>
            {order.map((rowIdx, displayIdx) => {
              const row = rows[rowIdx]!;
              const rowEdits = editable?.edits[rowIdx];
              const dirty = !!rowEdits && Object.keys(rowEdits).length > 0;
              return (
                <tr key={rowIdx} className={dirty ? "dirty" : ""}>
                  <td className="rownum-col">{rowStart + displayIdx}</td>
                  {rowLead && <td className="action-col">{rowLead(row, rowIdx)}</td>}
                  {row.map((cell, col) => {
                    const field = fields[col]!;
                    const pos = { row: displayIdx, col };
                    const isSel = selected?.row === displayIdx && selected.col === col;
                    const isEditing = editing?.row === displayIdx && editing.col === col;
                    const edited = rowEdits?.[field];
                    const value = edited !== undefined ? edited : cell;
                    const canEdit = !!editable?.canEditField(field);
                    return (
                      <td
                        key={col}
                        className={`${isSel ? "sel" : ""} ${edited !== undefined ? "edited" : ""} ${canEdit ? "editable" : ""}`}
                        onClick={() => setSelected(pos)}
                        onDoubleClick={() => {
                          if (canEdit) setEditing(pos);
                          else setViewer({ field, value });
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setSelected(pos);
                          setMenu({ x: e.clientX, y: e.clientY, pos });
                        }}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={value === null ? "" : cellText(value)}
                            onCommit={(v) => {
                              editable!.onEdit(rowIdx, field, v);
                              setEditing(null);
                              wrapRef.current?.focus();
                            }}
                            onCancel={() => {
                              setEditing(null);
                              wrapRef.current?.focus();
                            }}
                          />
                        ) : (
                          <CellValue value={value} />
                        )}
                      </td>
                    );
                  })}
                  {rowActions && <td className="action-col">{rowActions(row, rowIdx)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Value inspector — the full content of whatever cell is selected,
          since the table truncates long text. */}
      <div className="grid-inspector">
        {selected ? (
          <>
            <span className="inspector-field">{selectedField}</span>
            <code className="inspector-value">{selectedValue === null ? "NULL" : cellText(selectedValue)}</code>
            <button type="button" className="ghost tiny" onClick={() => void copyText(cellText(selectedValue), "Cell copied")}>
              Copy
            </button>
            <button type="button" className="ghost tiny" onClick={() => setViewer({ field: selectedField!, value: selectedValue })}>
              Open ↗
            </button>
          </>
        ) : (
          <span className="muted hint">Click a cell to inspect · double-click to {editable ? "edit" : "open"} · right-click for copy options</span>
        )}
        <div className="grow" />
        <label className="inline hint">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap
        </label>
      </div>

      {menu && (
        <GridMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Copy cell", onPick: () => void copyText(cellText(valueAt(menu.pos)), "Cell copied") },
            { label: "Copy column name", onPick: () => void copyText(fields[menu.pos.col]!, "Column copied") },
            { sep: true },
            { label: "Copy row as JSON", onPick: () => void copyText(JSON.stringify(rowObject(order[menu.pos.row]!), null, 2), "Row copied") },
            { label: "Copy row as CSV", onPick: () => void copyText(rowsToCsv(fields, [rows[order[menu.pos.row]!]!]), "Row copied") },
            { label: "Copy all rows as CSV", onPick: () => void copyText(rowsToCsv(fields, rows), `${rows.length} rows copied`) },
            { sep: true },
            { label: "Open value…", onPick: () => setViewer({ field: fields[menu.pos.col]!, value: valueAt(menu.pos) }) },
            ...(editable?.canEditField(fields[menu.pos.col]!)
              ? [
                  { sep: true as const },
                  { label: "Edit cell", onPick: () => setEditing(menu.pos) },
                  { label: "Set NULL", onPick: () => editable.onEdit(order[menu.pos.row]!, fields[menu.pos.col]!, null) },
                ]
              : []),
            ...(extraMenu
              ? [{ sep: true as const }, ...extraMenu({ rowIdx: order[menu.pos.row]!, field: fields[menu.pos.col]!, value: valueAt(menu.pos) })]
              : []),
          ]}
        />
      )}

      {viewer && <ValueViewer field={viewer.field} value={viewer.value} onClose={() => setViewer(null)} />}
    </div>
  );
}

function CellValue({ value }: { value: unknown }) {
  if (value === null) return <span className="null">NULL</span>;
  if (value === undefined) return <span className="null">—</span>;
  if (typeof value === "boolean") return <span className="bool">{String(value)}</span>;
  if (typeof value === "number" || typeof value === "bigint") return <span className="num">{String(value)}</span>;
  if (typeof value === "object") return <span className="json">{JSON.stringify(value)}</span>;
  return <>{String(value)}</>;
}

function CellEditor({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="cell-input"
      defaultValue={initial}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
        e.stopPropagation();
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
    />
  );
}

type MenuItem = { sep: true } | { sep?: false; label: string; onPick: () => void; danger?: boolean };

export function GridMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 8;
    setPos({
      left: x + r.width > window.innerWidth - m ? Math.max(m, window.innerWidth - r.width - m) : x,
      top: y + r.height > window.innerHeight - m ? Math.max(m, window.innerHeight - r.height - m) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={pos} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="context-sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={`context-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              it.onPick();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

function ValueViewer({ field, value, onClose }: { field: string; value: unknown; onClose: () => void }) {
  const { monacoTheme } = useTheme();
  const { text, language } = useMemo(() => {
    if (value === null) return { text: "NULL", language: "plaintext" };
    if (typeof value === "object") return { text: JSON.stringify(value, null, 2), language: "json" };
    const s = String(value);
    // Strings that hold JSON are common (jsonb columns come back parsed, but
    // text columns holding JSON don't) — pretty-print those too.
    const t = s.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), language: "json" };
      } catch {
        // fall through
      }
    }
    return { text: s, language: "plaintext" };
  }, [value]);

  return (
    <Modal
      title={
        <>
          {field} <span className="muted">· {text.length.toLocaleString()} chars</span>
        </>
      }
      onClose={onClose}
      width={720}
      flush
      tall
      headerExtra={
        <button type="button" className="ghost" onClick={() => void copyText(text)}>
          Copy
        </button>
      }
    >
      <Editor
        height="60vh"
        language={language}
        theme={monacoTheme}
        value={text}
        options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, wordWrap: "on", scrollBeyondLastLine: false }}
      />
    </Modal>
  );
}

export function cellText(v: unknown): string {
  if (v === null) return "NULL";
  if (v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
