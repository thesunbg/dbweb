import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { ConnectionConfig, QueryResultDto } from "@dbweb/shared-types";
import { api } from "../api.js";
import { TableBrowser } from "./TableBrowser.js";
import { Stats } from "./Stats.js";
import { DocumentModal } from "./DocumentModal.js";
import { DbTree, type TreeAction } from "./DbTree.js";
import { ResultGrid } from "./ResultGrid.js";
import { ResultChart } from "./ResultChart.js";
import { ErDiagram } from "./ErDiagram.js";
import { AiPanel } from "./AiPanel.js";
import { ImportModal } from "./ImportModal.js";
import { SnippetsModal } from "./SnippetsModal.js";
import { SchedulesModal } from "./SchedulesModal.js";
import { BackupsModal } from "./BackupsModal.js";
import { SchemaSearch } from "./SchemaSearch.js";
import { CompareModal } from "./CompareModal.js";
import { findParams, substituteParams } from "../lib/params.js";
import { downloadText, rowsToCsv, rowsToJson } from "../lib/export.js";
import { autoQuoteSql } from "../lib/sql-autoquote.js";
import { buildExplain, formatterDialect, isSqlKind } from "../lib/sql.js";
import { readPref, writePref } from "../lib/prefs.js";
import { confirmDialog, formDialog, promptDialog, toast, copyText } from "../lib/ui.js";
import { useTheme } from "../lib/theme.js";
import { COLOR_LABEL, KIND_LABEL } from "../lib/kinds.js";
import { shortVersion } from "../lib/format.js";

type QueryTab = { id: string; kind: "query"; title: string; statement: string; auto?: boolean };
type BrowseTab = { id: string; kind: "browse"; database: string; table: string };
type FixedTab = { id: "stats"; kind: "stats" } | { id: "history"; kind: "history" } | { id: "er"; kind: "er" };
type Tab = QueryTab | BrowseTab | FixedTab;

interface RunState {
  running: boolean;
  requestId?: string;
  result?: QueryResultDto;
  error?: string;
  note?: string | null;
  statement?: string;
  at?: number;
}

const STARTERS: Record<ConnectionConfig["kind"], string> = {
  mysql: "SELECT 1 AS hello, NOW() AS now;",
  postgres: "SELECT 1 AS hello, NOW() AS now;",
  oracle: "SELECT 1 AS hello FROM dual",
  mssql: "SELECT GETDATE() AS now",
  mongodb: "db.stats()",
  redis: "INFO server",
  dragonfly: "INFO server",
  clickhouse: "SELECT version() AS v, now() AS now",
};

const LANGUAGES: Record<ConnectionConfig["kind"], string> = {
  mysql: "sql",
  postgres: "sql",
  oracle: "sql",
  mssql: "sql",
  mongodb: "javascript",
  redis: "shell",
  dragonfly: "shell",
  clickhouse: "sql",
};

const MAX_ROWS_OPTIONS = [50, 200, 1000, 5000, 20000];

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "ORDER BY", "GROUP BY", "HAVING",
  "LIMIT", "OFFSET", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN", "ON", "AS", "DISTINCT", "COUNT", "SUM",
  "AVG", "MIN", "MAX", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
  "CASE", "WHEN", "THEN", "ELSE", "END", "UNION", "UNION ALL", "EXISTS", "WITH", "RETURNING", "EXPLAIN", "TRUNCATE",
  "INDEX", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "DEFAULT", "COALESCE", "CAST", "NOW()", "CURRENT_TIMESTAMP",
];

interface Props {
  connection: ConnectionConfig;
  connections: ConnectionConfig[];
  onEditConnection: () => void;
  onOpenSettings: () => void;
}

type Modal =
  | { type: "import"; table?: string }
  | { type: "snippets" }
  | { type: "schedules"; statement?: string }
  | { type: "backups" }
  | { type: "search" }
  | { type: "compare" }
  | null;

interface Persisted {
  tabs: (QueryTab | BrowseTab)[];
  active: string;
}

let tabSeq = 0;
const newTabId = () => `q${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

export function Workbench({ connection, connections, onEditConnection, onOpenSettings }: Props) {
  const qc = useQueryClient();
  const { monacoTheme } = useTheme();
  const starter = STARTERS[connection.kind];
  const language = LANGUAGES[connection.kind];
  const sql = isSqlKind(connection.kind);

  // ---- Tabs -------------------------------------------------------------
  const persistKey = `tabs:${connection.id}`;
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const saved = readPref<Persisted | null>(persistKey, null);
    if (saved && saved.tabs.length > 0) return saved.tabs;
    return [{ id: newTabId(), kind: "query", title: "Query 1", statement: starter }];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    const saved = readPref<Persisted | null>(persistKey, null);
    return saved?.active && saved.tabs.some((t) => t.id === saved.active) ? saved.active : (tabs[0]?.id ?? "");
  });
  useEffect(() => {
    const persistable = tabs.filter((t): t is QueryTab | BrowseTab => t.kind === "query" || t.kind === "browse");
    writePref(persistKey, { tabs: persistable, active: activeId } satisfies Persisted);
  }, [tabs, activeId, persistKey]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const updateTab = (id: string, patch: Partial<QueryTab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === "query" ? { ...t, ...patch } : t)));

  const addQueryTab = useCallback(
    (statement?: string, title?: string, auto = false): string => {
      const id = newTabId();
      setTabs((ts) => {
        const n = ts.filter((t) => t.kind === "query").length + 1;
        return [...ts, { id, kind: "query", title: title ?? `Query ${n}`, statement: statement ?? "", auto }];
      });
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTab = (id: string) => {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh: QueryTab = { id: newTabId(), kind: "query", title: "Query 1", statement: "" };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(next[Math.max(0, idx - 1)]!.id);
      return next;
    });
    setRuns((r) => {
      const { [id]: _drop, ...rest } = r;
      return rest;
    });
  };

  const openFixed = (kind: "stats" | "history" | "er") => {
    setTabs((ts) => (ts.some((t) => t.id === kind) ? ts : [...ts, { id: kind, kind } as FixedTab]));
    setActiveId(kind);
  };

  const openBrowse = (database: string, table: string) => {
    const existing = tabs.find((t) => t.kind === "browse" && t.database === database && t.table === table);
    if (existing) return setActiveId(existing.id);
    const id = newTabId();
    setTabs((ts) => [...ts, { id, kind: "browse", database, table }]);
    setActiveId(id);
  };

  /** Tree → editor. Reuses the active tab when it's still holding an
   *  untouched auto-inserted statement (or is empty), otherwise opens a
   *  new one so the user's work-in-progress is never clobbered. */
  const insertStatement = (statement: string, title?: string): string => {
    const cur = active;
    if (cur.kind === "query" && (cur.auto || cur.statement.trim() === "" || cur.statement === starter)) {
      updateTab(cur.id, { statement, auto: true, title: title ?? cur.title });
      return cur.id;
    }
    return addQueryTab(statement, title, true);
  };

  // ---- Connection state -------------------------------------------------
  const [database, setDatabase] = useState<string | undefined>(connection.database);
  const [maxRows, setMaxRows] = useState<number>(() => readPref("maxRows", 200));
  const [editorHeight, setEditorHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem("dbweb:editorHeight"));
    return v > 100 ? v : 220;
  });
  const [resultView, setResultView] = useState<"table" | "json" | "chart">(
    () => (localStorage.getItem("dbweb:resultView") as "table" | "json" | "chart") || "table",
  );
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(() => localStorage.getItem("dbweb:treeCollapsed") === "1");
  const [treeWidth, setTreeWidth] = useState<number>(() => readPref("treeWidth", 240));
  const [docModal, setDocModal] = useState<{ doc: Record<string, unknown>; collection: string } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [aiOpen, setAiOpen] = useState<boolean>(() => readPref("aiOpen", false));
  const [modal, setModal] = useState<Modal>(null);
  /** Explicit transaction pinned on the server (auto-commit off). */
  const [tx, setTx] = useState<{ id: string; statements: number } | null>(null);
  const readOnly = !!connection.readOnly;

  const ping = useQuery({
    queryKey: ["ping", connection.id],
    queryFn: () => api.testConnection(connection.id),
    retry: false,
  });
  const dbs = useQuery({
    queryKey: ["dbs", connection.id],
    queryFn: () => api.listDatabases(connection.id),
    enabled: ping.isSuccess,
  });
  const history = useQuery({
    queryKey: ["history", connection.id],
    queryFn: () => api.history(connection.id),
    enabled: ping.isSuccess,
  });
  const saved = useQuery({
    queryKey: ["saved", connection.id],
    queryFn: () => api.listSaved(connection.id),
    enabled: ping.isSuccess,
  });
  const needsAutoQuote = connection.kind === "postgres" || connection.kind === "oracle";
  const objects = useQuery({
    queryKey: ["objects", connection.id, database],
    queryFn: () => api.listObjects(connection.id, database!),
    enabled: !!database && ping.isSuccess && (needsAutoQuote || sql),
  });

  const saveMut = useMutation({
    mutationFn: ({ name, stmt }: { name: string; stmt: string }) => api.createSaved(connection.id, name, stmt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["saved", connection.id] });
      toast.success("Query saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteSavedMut = useMutation({
    mutationFn: (id: string) => api.deleteSaved(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved", connection.id] }),
  });

  // Everything the Monaco commands (registered once) need to read live.
  const latest = useRef({ tabs, activeId, database, maxRows, pingOk: ping.isSuccess, objects: objects.data, tx });
  latest.current = { tabs, activeId, database, maxRows, pingOk: ping.isSuccess, objects: objects.data, tx };
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const run = useCallback(
    async (tabId?: string, override?: string) => {
      const { tabs: ts, activeId: aid, database: db, maxRows: mr, pingOk, objects: objs, tx: curTx } = latest.current;
      const id = tabId ?? aid;
      const tab = ts.find((t) => t.id === id);
      if (!tab || tab.kind !== "query" || !pingOk) return;
      if (runs[id]?.running) return;

      let text = override;
      if (text === undefined) {
        // Run only the highlighted part when there is one — multi-statement
        // scratchpads are the norm and this is how every SQL tool works.
        const ed = editorRef.current;
        const sel = ed?.getSelection();
        const model = ed?.getModel();
        text = sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : tab.statement;
      }
      if (!text.trim()) return;

      // Query parameters: `:name` / `{{name}}` → ask once, remember per connection.
      const params = findParams(connection.kind, text);
      if (params.length > 0) {
        const remembered = readPref<Record<string, string>>(`params:${connection.id}`, {});
        const values = await formDialog({
          title: "Query parameters",
          message: `${params.length} parameter${params.length === 1 ? "" : "s"} found. Numbers stay bare, text is quoted, {{raw}} is inserted as-is.`,
          fields: params.map((p) => ({ name: p.name, label: p.raw ? `{{${p.name}}} (raw)` : `:${p.name}`, defaultValue: remembered[p.name] ?? "" })),
          confirmLabel: "Run",
        });
        if (!values) return;
        writePref(`params:${connection.id}`, { ...remembered, ...values });
        text = substituteParams(connection.kind, text, values);
      }

      const requestId = `${id}-${Date.now().toString(36)}`;
      let note: string | null = null;
      if (needsAutoQuote && objs) {
        const rewritten = autoQuoteSql(text, objs.map((o) => o.name));
        if (rewritten.replaced.length > 0) {
          text = rewritten.sql;
          note = `auto-quoted ${rewritten.replaced.map((n) => `"${n}"`).join(", ")}`;
        }
      }

      setRuns((r) => ({ ...r, [id]: { ...r[id], running: true, requestId, error: undefined, note } }));
      try {
        const result = await api.execute(connection.id, text, db, mr, { requestId, transactionId: curTx?.id });
        setRuns((r) => ({ ...r, [id]: { running: false, result, note, statement: text, at: Date.now() } }));
        if (curTx) setTx((t) => (t ? { ...t, statements: t.statements + 1 } : t));
      } catch (err) {
        setRuns((r) => ({ ...r, [id]: { ...r[id], running: false, error: (err as Error).message, result: undefined } }));
      } finally {
        void qc.invalidateQueries({ queryKey: ["history", connection.id] });
      }
    },
    [connection.id, connection.kind, needsAutoQuote, qc, runs],
  );
  const runRef = useRef(run);
  runRef.current = run;

  const cancelRun = async (tabId: string) => {
    const rid = runs[tabId]?.requestId;
    if (!rid) return;
    await api.cancel(connection.id, rid).catch(() => undefined);
  };

  const beginTx = async () => {
    try {
      const { transactionId } = await api.txBegin(connection.id, database);
      setTx({ id: transactionId, statements: 0 });
      toast.info("Transaction started — statements run on one session until you commit or roll back");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const endTx = async (action: "commit" | "rollback") => {
    if (!tx) return;
    try {
      if (action === "commit") await api.txCommit(connection.id, tx.id);
      else await api.txRollback(connection.id, tx.id);
      toast.success(action === "commit" ? `Committed ${tx.statements} statement${tx.statements === 1 ? "" : "s"}` : "Rolled back");
      setTx(null);
      void qc.invalidateQueries({ queryKey: ["browse", connection.id] });
    } catch (err) {
      toast.error((err as Error).message);
      setTx(null);
    }
  };
  // Tools that need a database context refuse to open without one.
  useEffect(() => {
    if ((modal?.type === "import" || modal?.type === "search") && !database) {
      toast.error("Select a database in the tree first");
      setModal(null);
    }
  }, [modal, database]);

  // Leaving the workbench with an open transaction rolls it back rather
  // than leaving a session pinned on the server.
  const txRef = useRef(tx);
  txRef.current = tx;
  useEffect(() => () => {
    if (txRef.current) void api.txRollback(connection.id, txRef.current.id).catch(() => undefined);
  }, [connection.id]);

  const saveCurrent = useCallback(async () => {
    const tab = latest.current.tabs.find((t) => t.id === latest.current.activeId);
    if (!tab || tab.kind !== "query" || !tab.statement.trim()) return;
    const name = await promptDialog({ title: "Save query", label: "Name", defaultValue: tab.title, confirmLabel: "Save" });
    if (name && name.trim()) saveMut.mutate({ name: name.trim(), stmt: tab.statement });
  }, [saveMut]);
  const saveRef = useRef(saveCurrent);
  saveRef.current = saveCurrent;

  // Global shortcuts (Monaco registers its own copies below so they also
  // fire while the editor has focus and swallows key events).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void runRef.current();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      } else if (e.key.toLowerCase() === "t" && e.altKey) {
        e.preventDefault();
        addQueryTab();
      } else if (e.key.toLowerCase() === "f" && e.shiftKey) {
        e.preventDefault();
        setModal({ type: "search" });
      } else if (e.key.toLowerCase() === "i" && e.shiftKey) {
        e.preventDefault();
        setAiOpen((v) => {
          writePref("aiOpen", !v);
          return !v;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addQueryTab]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void runRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    editor.onDidChangeCursorSelection((e) => setHasSelection(!e.selection.isEmpty()));

    // Table + column autocomplete for SQL dialects. Reads whatever the tree
    // and browser have already cached, so it gets smarter as you explore.
    if (sql) {
      const disposable = monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [".", " "],
        provideCompletionItems: (model: Parameters<Parameters<Monaco["languages"]["registerCompletionItemProvider"]>[1]["provideCompletionItems"]>[0], position: Parameters<Parameters<Monaco["languages"]["registerCompletionItemProvider"]>[1]["provideCompletionItems"]>[1]) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const suggestions: { label: string; kind: number; insertText: string; range: typeof range; detail?: string; sortText?: string }[] = [];
          const tables = latest.current.objects ?? [];
          for (const t of tables) {
            suggestions.push({ label: t.name, kind: monaco.languages.CompletionItemKind.Class, insertText: t.name, range, detail: t.kind, sortText: `0${t.name}` });
          }
          const colQueries = qc.getQueriesData<{ name: string; dataType: string }[]>({ queryKey: ["cols", connection.id] });
          const seen = new Set<string>();
          for (const [key, cols] of colQueries) {
            const table = String(key[3] ?? "");
            for (const c of cols ?? []) {
              const k = `${table}.${c.name}`;
              if (seen.has(k)) continue;
              seen.add(k);
              suggestions.push({ label: c.name, kind: monaco.languages.CompletionItemKind.Field, insertText: c.name, range, detail: `${table} · ${c.dataType}`, sortText: `1${c.name}` });
            }
          }
          for (const kw of SQL_KEYWORDS) {
            suggestions.push({ label: kw, kind: monaco.languages.CompletionItemKind.Keyword, insertText: kw, range, sortText: `2${kw}` });
          }
          return { suggestions };
        },
      });
      editor.onDidDispose(() => disposable.dispose());
    }
  };

  const formatCurrent = async () => {
    const dialect = formatterDialect(connection.kind);
    if (!dialect || active.kind !== "query") return;
    try {
      const { format } = await import("sql-formatter");
      updateTab(active.id, { statement: format(active.statement, { language: dialect, keywordCase: "upper" }), auto: false });
    } catch (err) {
      toast.error(`Format failed: ${(err as Error).message}`);
    }
  };

  const explainCurrent = () => {
    if (active.kind !== "query") return;
    const stmt = buildExplain(connection.kind, active.statement);
    if (!stmt) return toast.info("EXPLAIN is not available for this engine");
    const id = addQueryTab(stmt, `Explain · ${active.title}`, true);
    setTimeout(() => void runRef.current(id, stmt), 0);
  };

  const onTreeAction = (a: TreeAction) => {
    if (a.type === "browse") openBrowse(a.database, a.table);
    else if (a.type === "set-statement") insertStatement(a.statement, a.title);
    else if (a.type === "run-statement") {
      const id = insertStatement(a.statement, a.title);
      setTimeout(() => void runRef.current(id, a.statement), 0);
    } else if (a.type === "export") {
      const url = api.exportTableUrl(connection.id, a.database, a.table, a.format);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast.info(`Exporting ${a.table} as ${a.format.toUpperCase()}…`);
    }
  };

  const headerInfo = useMemo(() => {
    if (ping.isLoading) return "connecting…";
    if (ping.isError) return "offline";
    if (ping.data) return `${shortVersion(ping.data.serverVersion)} · ${ping.data.latencyMs}ms`;
    return "";
  }, [ping.isLoading, ping.isError, ping.data]);

  const activeRun = active.kind === "query" ? runs[active.id] : undefined;
  const result = activeRun?.result;

  return (
    <div className="workbench">
      <div className={`workbench-toolbar accent-${connection.color ?? "none"}`}>
        <div className="wb-title">
          <span className={`conn-icon kind-${connection.kind}`}>{KIND_LABEL[connection.kind].glyph}</span>
          <strong>{connection.name}</strong>
          <span className="muted">
            {connection.host}:{connection.port}
          </span>
          {connection.color && <span className={`env-pill env-${connection.color}`}>{COLOR_LABEL[connection.color]}</span>}
          {readOnly && (
            <span className="env-pill env-gray" title="Writes are blocked server-side. Change it in Edit connection.">
              🔒 read-only
            </span>
          )}
          {connection.ssh?.host && <span className="muted hint" title={`via SSH ${connection.ssh.username}@${connection.ssh.host}`}>⇄ ssh</span>}
        </div>
        <div className="wb-status">
          <span className={`status-dot ${ping.isSuccess ? "ok" : ping.isError ? "down" : "pending"}`} />
          <span className={ping.isError ? "error" : "muted"}>{headerInfo}</span>
          {ping.isError && (
            <button type="button" className="ghost tiny" onClick={() => void ping.refetch()}>
              Retry
            </button>
          )}
          <button
            type="button"
            className="ghost tiny"
            title="Reconnect (drop pooled adapter and ping again)"
            onClick={async () => {
              await api.disconnect(connection.id).catch(() => undefined);
              qc.removeQueries({ queryKey: ["dbs", connection.id] });
              qc.removeQueries({ queryKey: ["objects", connection.id] });
              await ping.refetch();
              toast.success("Reconnected");
            }}
          >
            ⟳
          </button>
        </div>
      </div>

      {ping.isError && (
        <div className="banner error-banner">
          <strong>Cannot connect:</strong> <span>{(ping.error as Error).message}</span>
          <div className="grow" />
          <button type="button" className="ghost" onClick={onEditConnection}>
            Edit connection
          </button>
          <button type="button" className="primary" onClick={() => void ping.refetch()}>
            Retry
          </button>
        </div>
      )}

      <div className={`workbench-grid ${treeCollapsed ? "tree-collapsed" : ""}`} style={!treeCollapsed ? { gridTemplateColumns: `${treeWidth}px 4px 1fr` } : undefined}>
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
            <DbTree connection={connection} database={database} setDatabase={setDatabase} onAction={onTreeAction} enabled={ping.isSuccess} />
          )}
        </aside>
        {!treeCollapsed && (
          <Divider
            axis="x"
            onDrag={(dx) =>
              setTreeWidth((w) => {
                const next = Math.max(160, Math.min(520, w + dx));
                writePref("treeWidth", next);
                return next;
              })
            }
          />
        )}

        <main className="workspace">
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className={`tab ${t.kind} ${t.id === activeId ? "active" : ""} ${runs[t.id]?.running ? "running" : ""}`}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                onDoubleClick={async () => {
                  if (t.kind !== "query") return;
                  const name = await promptDialog({ title: "Rename tab", defaultValue: t.title, confirmLabel: "Rename" });
                  if (name?.trim()) updateTab(t.id, { title: name.trim() });
                }}
                title={t.kind === "browse" ? `${t.database}.${t.table}` : t.kind === "query" ? "Double-click to rename · middle-click to close" : undefined}
              >
                <span className="tab-icon">{t.kind === "query" ? "≡" : t.kind === "browse" ? "▦" : t.kind === "stats" ? "◔" : t.kind === "er" ? "⛁" : "◷"}</span>
                <span className="tab-label">
                  {t.kind === "query" ? t.title : t.kind === "browse" ? t.table : t.kind === "stats" ? "Stats" : t.kind === "er" ? "ER" : "History"}
                </span>
                {runs[t.id]?.error && <span className="tab-dot err" />}
                <span
                  className="tab-close"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
            <button type="button" className="tab-add" onClick={() => addQueryTab()} title="New query tab (⌥⌘T)">
              +
            </button>
            <div className="grow" />
            <button type="button" className={`tab-util ${activeId === "stats" ? "active" : ""}`} onClick={() => openFixed("stats")}>
              ◔ Stats
            </button>
            <button type="button" className={`tab-util ${activeId === "history" ? "active" : ""}`} onClick={() => openFixed("history")}>
              ◷ History
            </button>
            <select
              className="tab-util tools-select"
              value=""
              title="Tools"
              onChange={(e) => {
                const v = e.target.value;
                if (v === "er") openFixed("er");
                else if (v === "search") setModal({ type: "search" });
                else if (v === "import") setModal({ type: "import", table: active.kind === "browse" ? active.table : undefined });
                else if (v === "snippets") setModal({ type: "snippets" });
                else if (v === "schedules") setModal({ type: "schedules", statement: active.kind === "query" ? active.statement : undefined });
                else if (v === "backups") setModal({ type: "backups" });
                else if (v === "compare") setModal({ type: "compare" });
                else if (v === "ai") setAiOpen((o) => { writePref("aiOpen", !o); return !o; });
              }}
            >
              <option value="">⚙ Tools…</option>
              <option value="ai">✨ AI assistant (⌘⇧I)</option>
              <option value="search">⌕ Find column / table (⌘⇧F)</option>
              <option value="er">⛁ ER diagram</option>
              <option value="import">↥ Import CSV / Excel</option>
              <option value="snippets">✂ Snippets</option>
              <option value="schedules">◷ Scheduled queries & alerts</option>
              <option value="backups">⛃ Backups</option>
              <option value="compare">⇄ Compare schema / data</option>
            </select>
          </div>

          {active.kind === "browse" ? (
            <TableBrowser
              key={active.id}
              connection={connection}
              database={active.database}
              table={active.table}
              onOpenInEditor={(stmt, title) => addQueryTab(stmt, title, true)}
              onImport={() => setModal({ type: "import", table: active.table })}
            />
          ) : active.kind === "er" ? (
            database ? <ErDiagram connection={connection} database={database} /> : <div className="result-empty muted">Select a database in the tree first.</div>
          ) : active.kind === "stats" ? (
            <Stats connection={connection} database={database} />
          ) : active.kind === "history" ? (
            <HistoryTab
              history={history.data ?? []}
              saved={saved.data ?? []}
              onOpen={(stmt, title) => addQueryTab(stmt, title)}
              onDeleteSaved={async (id, name) => {
                if (await confirmDialog({ title: `Delete saved query "${name}"?`, danger: true, confirmLabel: "Delete" })) deleteSavedMut.mutate(id);
              }}
            />
          ) : (
            <div className={`editor-area ${aiOpen ? "with-ai" : ""}`}>
            <div className="editor-main">
              <div className="editor-toolbar">
                {activeRun?.running ? (
                  <button type="button" className="primary run-btn danger" onClick={() => void cancelRun(active.id)} title="Cancel the running statement">
                    ■ Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary run-btn"
                    onClick={() => void run()}
                    disabled={!ping.isSuccess}
                    title="⌘/Ctrl + Enter"
                  >
                    {hasSelection ? "▶ Run selection" : "▶ Run"}
                  </button>
                )}

                {dbs.data && dbs.data.length > 0 && (
                  <label className="inline">
                    <span className="muted">DB</span>
                    <select className="db-select" value={database ?? ""} onChange={(e) => setDatabase(e.target.value || undefined)} title="Database queries run against">
                      <option value="">(default)</option>
                      {dbs.data.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="inline" title="Maximum rows returned to the browser">
                  <span className="muted">rows</span>
                  <select
                    value={maxRows}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setMaxRows(v);
                      writePref("maxRows", v);
                    }}
                  >
                    {MAX_ROWS_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n.toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>

                {sql && (
                  <>
                    <button type="button" className="ghost" onClick={() => void formatCurrent()} title="Format SQL">
                      ⌁ Format
                    </button>
                    <button type="button" className="ghost" onClick={explainCurrent} title="Run EXPLAIN in a new tab">
                      ◈ Explain
                    </button>
                  </>
                )}
                <button type="button" className="ghost" onClick={() => void saveCurrent()} title="Save query (⌘S)">
                  ☆ Save
                </button>
                {sql && !readOnly && (
                  tx ? (
                    <span className="tx-bar" title="Auto-commit is off: statements run inside one transaction">
                      <span className="tx-dot" /> tx · {tx.statements}
                      <button type="button" className="ghost tiny" onClick={() => void endTx("commit")}>
                        Commit
                      </button>
                      <button type="button" className="ghost tiny danger" onClick={() => void endTx("rollback")}>
                        Rollback
                      </button>
                    </span>
                  ) : (
                    (connection.kind === "postgres" || connection.kind === "mysql") && (
                      <button type="button" className="ghost" onClick={() => void beginTx()} title="Turn auto-commit off: run statements inside a transaction, then Commit or Rollback">
                        ⎔ Begin tx
                      </button>
                    )
                  )
                )}
                <button type="button" className={`ghost ${aiOpen ? "active" : ""}`} onClick={() => setAiOpen((o) => { writePref("aiOpen", !o); return !o; })} title="AI assistant (⌘⇧I)">
                  ✨ AI
                </button>
                {saved.data && saved.data.length > 0 && (
                  <select
                    className="saved-select"
                    value=""
                    title="Insert a saved query"
                    onChange={(e) => {
                      const s = saved.data?.find((x) => x.id === e.target.value);
                      if (s) addQueryTab(s.statement, s.name);
                    }}
                  >
                    <option value="">★ Saved…</option>
                    {saved.data.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}

                <div className="grow" />

                {result && (
                  <span className="muted result-meta">
                    {result.fields.length > 0 && <>{result.rowCount.toLocaleString()} rows</>}
                    {result.affectedRows !== undefined && <> · {result.affectedRows} affected</>}
                    <> · {result.elapsedMs}ms</>
                    {result.truncated && <span className="warn"> · truncated at {maxRows}</span>}
                  </span>
                )}
                {activeRun?.note && (
                  <span className="muted hint" title="dbweb detected mixed-case names and quoted them automatically">
                    ✎ {activeRun.note}
                  </span>
                )}
                {result && result.fields.length > 0 && (
                  <>
                    <div className="seg" role="group">
                      <button type="button" className={`seg-btn ${resultView === "table" ? "active" : ""}`} onClick={() => setView("table")}>
                        Table
                      </button>
                      <button type="button" className={`seg-btn ${resultView === "json" ? "active" : ""}`} onClick={() => setView("json")}>
                        JSON
                      </button>
                      <button type="button" className={`seg-btn ${resultView === "chart" ? "active" : ""}`} onClick={() => setView("chart")}>
                        Chart
                      </button>
                    </div>
                    <ExportMenu
                      onCsv={() => downloadText(`${connection.name}-result.csv`, "﻿" + rowsToCsv(result.fields, result.rows), "text/csv")}
                      onJson={() => downloadText(`${connection.name}-result.json`, rowsToJson(result.fields, result.rows), "application/json")}
                      onCopyJson={() => void copyText(rowsToJson(result.fields, result.rows), "JSON copied")}
                      onCopyCsv={() => void copyText(rowsToCsv(result.fields, result.rows), "CSV copied")}
                    />
                  </>
                )}
              </div>

              <div className="editor-pane" style={{ height: editorHeight }}>
                <Editor
                  height="100%"
                  path={`${connection.id}/${active.id}.${language}`}
                  language={language}
                  theme={monacoTheme}
                  value={active.statement}
                  onChange={(v) => updateTab(active.id, { statement: v ?? "", auto: false })}
                  onMount={onMount}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    padding: { top: 8 },
                    suggest: { showWords: true },
                    quickSuggestions: true,
                  }}
                />
              </div>
              <Divider
                axis="y"
                onDrag={(dy) =>
                  setEditorHeight((h) => {
                    const next = Math.max(80, Math.min(800, h + dy));
                    localStorage.setItem("dbweb:editorHeight", String(next));
                    return next;
                  })
                }
              />

              <div className="result-pane">
                {activeRun?.running && (
                  <div className="result-loading">
                    Running… <button type="button" className="ghost tiny" onClick={() => void cancelRun(active.id)}>Cancel</button>
                  </div>
                )}
                {activeRun?.error && (
                  <div className="error result-error">
                    <pre>{activeRun.error}</pre>
                    <button type="button" className="ghost tiny" onClick={() => void copyText(activeRun.error!, "Error copied")}>
                      Copy
                    </button>
                  </div>
                )}
                {result && result.fields.length > 0 && resultView === "json" && (
                  <Editor
                    height="100%"
                    language="json"
                    theme={monacoTheme}
                    value={resultToJson(result.fields, result.rows)}
                    options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: "on" }}
                  />
                )}
                {result && result.fields.length > 0 && resultView === "chart" && <ResultChart fields={result.fields} rows={result.rows} />}
                {result && result.fields.length > 0 && resultView === "table" && (
                  <ResultGrid
                    fields={result.fields}
                    rows={result.rows}
                    rowLead={
                      connection.kind === "mongodb"
                        ? (row) => {
                            const docObj = rowToDoc(result.fields, row);
                            const hasId = "_id" in docObj;
                            return (
                              <button
                                type="button"
                                className="ghost icon-btn"
                                title={hasId ? "Edit document" : "View document"}
                                onClick={() => setDocModal({ doc: docObj, collection: detectCollection(activeRun?.statement ?? active.statement) ?? "?" })}
                              >
                                {hasId ? "✎" : "👁"}
                              </button>
                            );
                          }
                        : undefined
                    }
                  />
                )}
                {result && result.fields.length === 0 && !activeRun?.error && (
                  <div className="result-ok">
                    ✓ Statement OK{result.affectedRows !== undefined ? ` · ${result.affectedRows} row${result.affectedRows === 1 ? "" : "s"} affected` : ""} · {result.elapsedMs}ms
                  </div>
                )}
                {!result && !activeRun?.error && !activeRun?.running && (
                  <div className="result-empty muted">
                    <div>Run a query to see results here.</div>
                    <div className="hint">⌘⏎ run · highlight text to run only that part · ⌘S save · ⌥⌘T new tab · :param or {"{{param}}"} prompts for values</div>
                  </div>
                )}
              </div>
            </div>
            {aiOpen && (
              <AiPanel
                connection={connection}
                database={database}
                statement={active.statement}
                lastError={activeRun?.error}
                onInsert={(stmt, title) => addQueryTab(stmt, title, true)}
                onRun={(stmt, title) => {
                  const id = addQueryTab(stmt, title, true);
                  setTimeout(() => void runRef.current(id, stmt), 0);
                }}
                onOpenSettings={onOpenSettings}
                onClose={() => {
                  setAiOpen(false);
                  writePref("aiOpen", false);
                }}
              />
            )}
            </div>
          )}
        </main>
      </div>

      {modal?.type === "import" && database && (
        <ImportModal
          connection={connection}
          database={database}
          table={modal.table}
          onClose={() => setModal(null)}
          onImported={() => {
            void qc.invalidateQueries({ queryKey: ["browse", connection.id] });
            void qc.invalidateQueries({ queryKey: ["browse-count", connection.id] });
            void qc.invalidateQueries({ queryKey: ["objects", connection.id] });
          }}
        />
      )}

      {modal?.type === "snippets" && (
        <SnippetsModal
          kind={connection.kind}
          initialStatement={undefined}
          onInsert={async (stmt, title) => {
            setModal(null);
            addQueryTab(stmt, title, true);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "schedules" && <SchedulesModal connection={connection} database={database} initialStatement={modal.statement} onClose={() => setModal(null)} />}
      {modal?.type === "backups" && <BackupsModal connection={connection} database={database} onClose={() => setModal(null)} />}
      {modal?.type === "compare" && <CompareModal connections={connections} initial={connection} initialDatabase={database} onClose={() => setModal(null)} />}
      {modal?.type === "search" && database && (
        <SchemaSearch
          connection={connection}
          database={database}
          onPick={(table, column) => {
            if (column) void copyText(column, `Copied "${column}"`);
            if (sql) openBrowse(database, table);
            else insertStatement(connection.kind === "mongodb" ? `db.${table}.find()` : `KEY ${table}`, table);
          }}
          onClose={() => setModal(null)}
        />
      )}


      {docModal && database && (
        <DocumentModal
          connection={connection}
          database={database}
          collection={docModal.collection}
          doc={docModal.doc}
          editable={connection.kind === "mongodb" && "_id" in docModal.doc}
          onClose={() => setDocModal(null)}
          onSaved={() => void run()}
        />
      )}
    </div>
  );

  function setView(v: "table" | "json" | "chart") {
    setResultView(v);
    localStorage.setItem("dbweb:resultView", v);
  }
}

function ExportMenu({ onCsv, onJson, onCopyJson, onCopyCsv }: { onCsv: () => void; onJson: () => void; onCopyJson: () => void; onCopyCsv: () => void }) {
  return (
    <select
      className="saved-select"
      value=""
      title="Export result"
      onChange={(e) => {
        const v = e.target.value;
        if (v === "csv") onCsv();
        else if (v === "json") onJson();
        else if (v === "copy-json") onCopyJson();
        else if (v === "copy-csv") onCopyCsv();
      }}
    >
      <option value="">↓ Export…</option>
      <option value="csv">Download CSV</option>
      <option value="json">Download JSON</option>
      <option value="copy-csv">Copy as CSV</option>
      <option value="copy-json">Copy as JSON</option>
    </select>
  );
}

interface HistoryTabProps {
  history: { id: string; statement: string; elapsedMs: number; rowCount: number; error?: string; createdAt: string }[];
  saved: { id: string; name: string; statement: string }[];
  onOpen: (statement: string, title?: string) => void;
  onDeleteSaved: (id: string, name: string) => void;
}

function HistoryTab({ history, saved, onOpen, onDeleteSaved }: HistoryTabProps) {
  const [q, setQ] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const term = q.trim().toLowerCase();
  const filtered = history.filter((h) => (!term || h.statement.toLowerCase().includes(term)) && (!onlyErrors || h.error));
  const filteredSaved = saved.filter((s) => !term || s.name.toLowerCase().includes(term) || s.statement.toLowerCase().includes(term));

  return (
    <div className="history-tab">
      <div className="history-toolbar">
        <div className="conn-search grow">
          <span className="conn-search-icon">⌕</span>
          <input type="search" value={q} placeholder="Search history & saved queries…" onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="inline hint">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> errors only
        </label>
        <span className="muted hint">
          {filtered.length}/{history.length}
        </span>
      </div>

      <section className="history-section">
        <h4>★ Saved queries</h4>
        {filteredSaved.length === 0 && <div className="muted hint">None yet — press ⌘S in the editor to save the current query.</div>}
        <ul className="hist-list">
          {filteredSaved.map((s) => (
            <li key={s.id} className="history-item full" onClick={() => onOpen(s.statement, s.name)} title="Open in a new tab">
              <span className="hist-status ok">★</span>
              <span className="hist-name">{s.name}</span>
              <code className="hist-stmt">{s.statement}</code>
              <span className="row-tight">
                <button type="button" className="ghost icon-btn" title="Copy" onClick={(e) => { e.stopPropagation(); void copyText(s.statement); }}>
                  ⧉
                </button>
                <button type="button" className="ghost icon-btn danger" title="Delete" onClick={(e) => { e.stopPropagation(); onDeleteSaved(s.id, s.name); }}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="history-section">
        <h4>Recent queries</h4>
        {filtered.length === 0 && <div className="muted hint">Nothing here yet.</div>}
        <ul className="hist-list">
          {filtered.map((h) => (
            <li key={h.id} className="history-item full" onClick={() => onOpen(h.statement)} title={h.error ?? "Open in a new tab"}>
              <span className={`hist-status ${h.error ? "err" : "ok"}`}>{h.error ? "✕" : "✓"}</span>
              <span className="hist-meta">
                {h.elapsedMs}ms · {h.rowCount}r
              </span>
              <code className="hist-stmt">{h.statement}</code>
              <span className="hist-time">{formatWhen(h.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function rowToDoc(fields: string[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f, i) => [f, row[i]]));
}

function resultToJson(fields: string[], rows: unknown[][]): string {
  if (fields.length === 1 && fields[0] === "result") {
    return JSON.stringify(rows.map((r) => r[0]), jsonReplacer, 2);
  }
  return JSON.stringify(rows.map((r) => rowToDoc(fields, r)), jsonReplacer, 2);
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (v && typeof v === "object") {
    const bson = (v as { _bsontype?: string })._bsontype;
    if (bson === "ObjectID" || bson === "ObjectId") return (v as { toString(): string }).toString();
  }
  return v;
}

function detectCollection(statement: string): string | null {
  const shell = /^\s*db\.(\w+)\./.exec(statement);
  if (shell) return shell[1] ?? null;
  try {
    const parsed = JSON.parse(statement) as Record<string, unknown>;
    const coll = parsed.find ?? parsed.aggregate;
    if (typeof coll === "string") return coll;
  } catch {
    // not JSON
  }
  return null;
}

/** Drag handle between panes. `axis="y"` resizes vertically, `"x"` horizontally. */
export function Divider({ axis, onDrag }: { axis: "x" | "y"; onDrag: (delta: number) => void }) {
  const start = useRef<number | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (start.current === null) return;
      const cur = axis === "y" ? e.clientY : e.clientX;
      onDrag(cur - start.current);
      start.current = cur;
    };
    const onUp = () => {
      start.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onDrag, axis]);

  return (
    <div
      className={`pane-divider ${axis}`}
      onMouseDown={(e) => {
        start.current = axis === "y" ? e.clientY : e.clientX;
        document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
        document.body.style.userSelect = "none";
      }}
    />
  );
}
