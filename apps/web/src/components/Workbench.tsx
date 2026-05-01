import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { TableBrowser } from "./TableBrowser.js";
import { Stats } from "./Stats.js";
import { DocumentModal } from "./DocumentModal.js";
import { DbTree, type TreeAction } from "./DbTree.js";
import { downloadText, rowsToCsv, rowsToJson } from "../lib/export.js";

type Tab =
  | { kind: "editor" }
  | { kind: "browse"; database: string; table: string }
  | { kind: "stats" }
  | { kind: "history" };

const STARTERS: Record<ConnectionConfig["kind"], string> = {
  mysql: "SELECT 1 AS hello, NOW() AS now;",
  postgres: "SELECT 1 AS hello, NOW() AS now;",
  oracle: "SELECT 1 AS hello FROM dual",
  mssql: "SELECT GETDATE() AS now",
  mongodb: '{ "find": "users", "filter": {}, "limit": 50 }',
  redis: "INFO server",
};

const LANGUAGES: Record<ConnectionConfig["kind"], string> = {
  mysql: "sql",
  postgres: "sql",
  oracle: "sql",
  mssql: "sql",
  mongodb: "json",
  redis: "shell",
};

interface Props {
  connection: ConnectionConfig;
}

export function Workbench({ connection }: Props) {
  const qc = useQueryClient();
  const [database, setDatabase] = useState<string | undefined>(connection.database);
  const initialStatement = STARTERS[connection.kind];
  const [statement, setStatement] = useState<string>(initialStatement);
  const language = LANGUAGES[connection.kind];
  const [tab, setTab] = useState<Tab>({ kind: "editor" });
  // Editor pane height in px — drag the divider to resize; result fills the
  // rest. Persisted so it survives page reloads.
  const [editorHeight, setEditorHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem("dbweb:editorHeight"));
    return v > 100 ? v : 240;
  });
  const [resultView, setResultView] = useState<"table" | "json">(
    () => (localStorage.getItem("dbweb:resultView") as "table" | "json") || "table",
  );
  const setResultViewPersist = (v: "table" | "json") => {
    setResultView(v);
    localStorage.setItem("dbweb:resultView", v);
  };
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(
    () => localStorage.getItem("dbweb:treeCollapsed") === "1",
  );
  const [docModal, setDocModal] = useState<{ doc: Record<string, unknown>; collection: string } | null>(null);

  const ping = useQuery({
    queryKey: ["ping", connection.id],
    queryFn: () => api.testConnection(connection.id),
    retry: false,
  });

  const history = useQuery({
    queryKey: ["history", connection.id],
    queryFn: () => api.history(connection.id),
    enabled: ping.isSuccess,
  });

  const exec = useMutation({
    mutationFn: () => api.execute(connection.id, statement, database),
    onSettled: () => qc.invalidateQueries({ queryKey: ["history", connection.id] }),
  });

  const saved = useQuery({
    queryKey: ["saved", connection.id],
    queryFn: () => api.listSaved(connection.id),
    enabled: ping.isSuccess,
  });

  const saveMut = useMutation({
    mutationFn: ({ name, stmt }: { name: string; stmt: string }) =>
      api.createSaved(connection.id, name, stmt),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved", connection.id] }),
  });
  const deleteSavedMut = useMutation({
    mutationFn: (id: string) => api.deleteSaved(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved", connection.id] }),
  });

  const stmtRef = useRef(statement);
  stmtRef.current = statement;
  // Refs that the Monaco command closure can dereference at runtime — Monaco
  // keybindings are registered once on mount, but our mutation/ping change
  // identity on every render, so we route through refs instead of closures.
  const execRef = useRef(exec);
  execRef.current = exec;
  const pingRef = useRef(ping);
  pingRef.current = ping;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (ping.isSuccess && !exec.isPending) exec.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ping.isSuccess, exec]);

  const result = exec.data;
  const errorMsg = exec.error ? (exec.error as Error).message : undefined;

  const headerInfo = useMemo(() => {
    if (ping.isLoading) return "connecting...";
    if (ping.isError) return `failed: ${(ping.error as Error).message}`;
    if (ping.data) return `${ping.data.serverVersion ?? "ok"} · ${ping.data.latencyMs}ms`;
    return "";
  }, [ping]);

  return (
    <div className="workbench">
      <div className="workbench-toolbar">
        <div>
          <strong>{connection.name}</strong>
          <span className="muted"> · {connection.host}:{connection.port}</span>
        </div>
        <div className={`muted ${ping.isError ? "error" : ""}`}>{headerInfo}</div>
      </div>

      <div
        className={`workbench-grid ${treeCollapsed ? "tree-collapsed" : ""}`}
      >
        <aside className="db-tree">
          <button
            type="button"
            className="tree-toggle"
            onClick={() => {
              const next = !treeCollapsed;
              setTreeCollapsed(next);
              localStorage.setItem("dbweb:treeCollapsed", next ? "1" : "0");
            }}
            title={treeCollapsed ? "Expand tree" : "Collapse tree"}
          >
            {treeCollapsed ? "›" : "‹"}
          </button>
          {!treeCollapsed && (
            <DbTree
              connection={connection}
              database={database}
              setDatabase={setDatabase}
              onAction={(a: TreeAction) => {
                if (a.type === "browse") {
                  setTab({ kind: "browse", database: a.database, table: a.table });
                } else if (a.type === "set-statement") {
                  setStatement(a.statement);
                  setTab({ kind: "editor" });
                } else if (a.type === "run-statement") {
                  setStatement(a.statement);
                  setTab({ kind: "editor" });
                  // Defer one tick so Monaco picks up the new value before run.
                  setTimeout(() => exec.mutate(), 0);
                }
              }}
            />
          )}
        </aside>

        <main className="workspace">
          <div className="tabs">
            <button
              type="button"
              className={`tab ${tab.kind === "editor" ? "active" : ""}`}
              onClick={() => setTab({ kind: "editor" })}
            >
              Editor
            </button>
            <button
              type="button"
              className={`tab ${tab.kind === "stats" ? "active" : ""}`}
              onClick={() => setTab({ kind: "stats" })}
            >
              Stats
            </button>
            <button
              type="button"
              className={`tab ${tab.kind === "history" ? "active" : ""}`}
              onClick={() => setTab({ kind: "history" })}
            >
              History
            </button>
            {tab.kind === "browse" && (
              <button type="button" className="tab active">
                {tab.database}.{tab.table}
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTab({ kind: "editor" });
                  }}
                >
                  ×
                </span>
              </button>
            )}
          </div>

          {tab.kind === "browse" ? (
            <TableBrowser
              connection={connection}
              database={tab.database}
              table={tab.table}
            />
          ) : tab.kind === "stats" ? (
            <Stats connection={connection} database={database} />
          ) : tab.kind === "history" ? (
            <div className="history-tab">
              <section className="history-section">
                <h4>★ Saved</h4>
                {saved.data && saved.data.length === 0 && (
                  <div className="muted">none — use ☆ Save in editor toolbar</div>
                )}
                <ul className="hist-list">
                  {saved.data?.map((s) => (
                    <li
                      key={s.id}
                      className="history-item full"
                      onClick={() => {
                        setStatement(s.statement);
                        setTab({ kind: "editor" });
                      }}
                    >
                      <span className="hist-status ok">★</span>
                      <span className="hist-name">{s.name}</span>
                      <code className="hist-stmt">{s.statement.slice(0, 120)}</code>
                      <button
                        type="button"
                        className="ghost icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete "${s.name}"?`)) deleteSavedMut.mutate(s.id);
                        }}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="history-section">
                <h4>History</h4>
                {history.data && history.data.length === 0 && (
                  <div className="muted">no queries run yet</div>
                )}
                <ul className="hist-list">
                  {history.data?.map((h) => (
                    <li
                      key={h.id}
                      className="history-item full"
                      onClick={() => {
                        setStatement(h.statement);
                        setTab({ kind: "editor" });
                      }}
                      title={`${h.elapsedMs}ms · ${h.rowCount} rows`}
                    >
                      <span className={`hist-status ${h.error ? "err" : "ok"}`}>
                        {h.error ? "✕" : "✓"}
                      </span>
                      <span className="hist-meta">
                        {h.elapsedMs}ms · {h.rowCount}r
                      </span>
                      <code className="hist-stmt">{h.statement}</code>
                      <span className="hist-time">{h.createdAt.slice(11, 19)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : (
            <>
              <div className="editor-toolbar">
                <button
                  type="button"
                  className="primary"
                  onClick={() => exec.mutate()}
                  disabled={exec.isPending || !ping.isSuccess}
                >
                  {exec.isPending ? "Running..." : "Run ▶"}
                </button>
                {result && (
                  <span className="muted">
                    {result.rowCount} rows · {result.elapsedMs}ms
                    {result.truncated && " · truncated"}
                    {result.affectedRows !== undefined && ` · ${result.affectedRows} affected`}
                  </span>
                )}
                {result && result.fields.length > 0 && (
                  <>
                    <div className="seg" role="group">
                      <button
                        type="button"
                        className={`seg-btn ${resultView === "table" ? "active" : ""}`}
                        onClick={() => setResultViewPersist("table")}
                      >
                        Table
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${resultView === "json" ? "active" : ""}`}
                        onClick={() => setResultViewPersist("json")}
                      >
                        JSON
                      </button>
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        downloadText(
                          `${connection.name}-result.csv`,
                          rowsToCsv(result.fields, result.rows),
                          "text/csv",
                        )
                      }
                    >
                      ↓ CSV
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        downloadText(
                          `${connection.name}-result.json`,
                          rowsToJson(result.fields, result.rows),
                          "application/json",
                        )
                      }
                    >
                      ↓ JSON
                    </button>
                  </>
                )}
                <div className="grow" />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    const name = prompt("Save as:");
                    if (name) saveMut.mutate({ name, stmt: stmtRef.current });
                  }}
                  title="Save current query"
                >
                  ☆ Save
                </button>
                <span className="muted hint">⌘/Ctrl + Enter</span>
              </div>

              <div className="editor-pane" style={{ height: editorHeight }}>
                <Editor
                  height="100%"
                  language={language}
                  theme="vs-dark"
                  value={statement}
                  onChange={(v) => setStatement(v ?? "")}
                  onMount={(editor, monaco) => {
                    // Cmd/Ctrl + Enter must run, not insert a newline. The
                    // window-level listener doesn't fire here because Monaco
                    // captures the event, so we register it on the editor.
                    editor.addCommand(
                      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                      () => {
                        if (pingRef.current.isSuccess && !execRef.current.isPending) {
                          execRef.current.mutate();
                        }
                      },
                    );
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
              <PaneDivider
                onDrag={(dy) => {
                  setEditorHeight((h) => {
                    const next = Math.max(80, Math.min(800, h + dy));
                    localStorage.setItem("dbweb:editorHeight", String(next));
                    return next;
                  });
                }}
              />

              <div className="result-pane">
            {errorMsg && <div className="error result-error">{errorMsg}</div>}
            {result && result.fields.length > 0 && resultView === "json" && (
              <Editor
                height="100%"
                language="json"
                theme="vs-dark"
                value={resultToJson(result.fields, result.rows)}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                }}
              />
            )}
            {result && result.fields.length > 0 && resultView === "table" && (
              <div className="result-table-wrap">
                <table className="result-table">
                  <thead>
                    <tr>
                      {connection.kind === "mongodb" && <th className="action-col">·</th>}
                      {result.fields.map((f) => (
                        <th key={f}>{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => {
                      const docObj = rowToDoc(result.fields, row);
                      const hasId = "_id" in docObj;
                      return (
                        <tr key={i}>
                          {connection.kind === "mongodb" && (
                            <td className="action-col">
                              <button
                                type="button"
                                className="ghost icon"
                                title={hasId ? "Edit JSON" : "View JSON"}
                                onClick={() => {
                                  // Detect collection from common spots: shell-style input
                                  // db.<coll>.find(...), or JSON command. Fall back to "?".
                                  const coll = detectCollection(stmtRef.current) ?? "?";
                                  setDocModal({ doc: docObj, collection: coll });
                                }}
                              >
                                {hasId ? "✎" : "👁"}
                              </button>
                            </td>
                          )}
                          {row.map((cell, j) => (
                            <td key={j}>{renderCell(cell)}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {result && result.fields.length === 0 && !errorMsg && (
              <div className="muted">Statement OK. {result.affectedRows ?? 0} rows affected.</div>
            )}
          </div>

            </>
          )}
        </main>
      </div>

      {docModal && database && (
        <DocumentModal
          connection={connection}
          database={database}
          collection={docModal.collection}
          doc={docModal.doc}
          editable={connection.kind === "mongodb" && "_id" in docModal.doc}
          onClose={() => setDocModal(null)}
          onSaved={() => exec.mutate()}
        />
      )}
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null) return "NULL";
  if (v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function rowToDoc(fields: string[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f, i) => [f, row[i]]));
}

function resultToJson(fields: string[], rows: unknown[][]): string {
  // If the result was a single non-object scalar (column "result"), unwrap it
  // so the JSON view shows the value, not [{ result: ... }].
  if (fields.length === 1 && fields[0] === "result") {
    return JSON.stringify(
      rows.map((r) => r[0]),
      jsonReplacer,
      2,
    );
  }
  const docs = rows.map((r) => rowToDoc(fields, r));
  return JSON.stringify(docs, jsonReplacer, 2);
}

function jsonReplacer(_k: string, v: unknown): unknown {
  // Mongo v3 stamps ObjectId with _bsontype='ObjectID'; v5+ uses 'ObjectId'
  // (lowercase d). Collapse either form to its hex string for readability.
  if (v && typeof v === "object") {
    const bson = (v as { _bsontype?: string })._bsontype;
    if (bson === "ObjectID" || bson === "ObjectId") {
      return (v as { toString(): string }).toString();
    }
  }
  return v;
}

function detectCollection(statement: string): string | null {
  // db.<coll>.<method>( ... ) — the dominant form users will type.
  const shell = /^\s*db\.(\w+)\./.exec(statement);
  if (shell) return shell[1] ?? null;
  // Backwards-compat with the JSON command form.
  try {
    const parsed = JSON.parse(statement) as Record<string, unknown>;
    const coll = parsed.find ?? parsed.aggregate;
    if (typeof coll === "string") return coll;
  } catch {
    // not JSON
  }
  return null;
}

interface DividerProps {
  onDrag: (dy: number) => void;
}

function PaneDivider({ onDrag }: DividerProps) {
  // Tracks whether the user is currently mid-drag. We attach window-level
  // listeners during the drag so the cursor doesn't lose grip when leaving
  // the divider element itself.
  const startY = useRef<number | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (startY.current === null) return;
      onDrag(e.clientY - startY.current);
      startY.current = e.clientY;
    };
    const onUp = () => {
      startY.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onDrag]);

  return (
    <div
      className="pane-divider"
      onMouseDown={(e) => {
        startY.current = e.clientY;
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      }}
    />
  );
}
