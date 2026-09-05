import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { GridMenu } from "./ResultGrid.js";
import { buildSelectStatement, buildShowColumns, buildShowCreate, isSqlKind, quoteQualified } from "../lib/sql.js";
import { copyText } from "../lib/ui.js";
import { shortType } from "../lib/format.js";

interface Props {
  connection: ConnectionConfig;
  database: string | undefined;
  setDatabase: (db: string) => void;
  onAction: (a: TreeAction) => void;
  /** False while the connection ping is failing — the tree stays quiet
   *  instead of stacking its own error on top of the banner. */
  enabled?: boolean;
}

export type TreeAction =
  | { type: "browse"; database: string; table: string }
  | { type: "set-statement"; statement: string; title?: string }
  | { type: "run-statement"; statement: string; title?: string }
  | { type: "export"; database: string; table: string; format: "json" | "csv" | "xlsx" };

/**
 * Schema tree:
 *
 *   host
 *   ├ database                       ← click to select + expand
 *   │  ├ table                       ← click: browse rows · ⋯ / right-click: actions
 *   │  │  ├ column  type             ← SQL kinds expand to columns (lazy)
 *   │  │  └ …
 *   │  └ collection ▸ Indexes/Stats  ← Mongo
 *   └ …
 */
export function DbTree({ connection, database, setDatabase, onAction, enabled = true }: Props) {
  const qc = useQueryClient();
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(() => new Set(database ? [database] : []));
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [hostExpanded, setHostExpanded] = useState(true);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<
    | { x: number; y: number; target: "host" }
    | { x: number; y: number; target: "item"; database: string; item: string; kind: string }
    | null
  >(null);

  const dbs = useQuery({
    queryKey: ["dbs", connection.id],
    queryFn: () => api.listDatabases(connection.id),
    enabled,
  });

  // A single DB (or the connection's configured one) auto-expands so the
  // user lands on tables without an extra click.
  useEffect(() => {
    if (!dbs.data) return;
    if (dbs.data.length === 1) {
      const only = dbs.data[0]!.name;
      setExpandedDbs((s) => (s.has(only) ? s : new Set([...s, only])));
      if (!database) setDatabase(only);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbs.data]);

  const toggleDb = (name: string) => {
    setExpandedDbs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setDatabase(name);
  };

  const toggleItem = (key: string) =>
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["dbs", connection.id] });
    void qc.invalidateQueries({ queryKey: ["objects", connection.id] });
    void qc.invalidateQueries({ queryKey: ["cols", connection.id] });
  };

  const term = filter.trim().toLowerCase();
  const dbCount = dbs.data?.length ?? 0;

  return (
    <div className="dbtree">
      <div className="tree-head">
        <div className="conn-search grow">
          <span className="conn-search-icon">⌕</span>
          <input
            type="search"
            value={filter}
            placeholder="Filter tables…"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          />
        </div>
        <button type="button" className="ghost icon-btn" title="Refresh schema" onClick={refresh}>
          ⟳
        </button>
      </div>

      <NodeRow
        indent={0}
        expanded={hostExpanded}
        hasChildren
        icon="server"
        label={`${connection.host}${dbCount ? ` · ${dbCount} db` : ""}`}
        onToggle={() => setHostExpanded((v) => !v)}
        onActivate={() => setHostExpanded((v) => !v)}
        onContext={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, target: "host" });
        }}
      />
      {hostExpanded && (
        <>
          {dbs.isLoading && <div className="muted small indent-1">loading…</div>}
          {dbs.isError && <div className="error small indent-1">{(dbs.error as Error).message}</div>}
          {dbs.data?.length === 0 && <div className="muted small indent-1">no databases visible</div>}
          <ul className="tree">
            {dbs.data?.map((d) => {
              const expanded = expandedDbs.has(d.name);
              return (
                <li key={d.name}>
                  <NodeRow
                    indent={1}
                    expanded={expanded}
                    hasChildren
                    icon="db"
                    label={d.name}
                    active={database === d.name}
                    onToggle={() => toggleDb(d.name)}
                    onActivate={() => toggleDb(d.name)}
                  />
                  {expanded && (
                    <ItemList
                      connection={connection}
                      database={d.name}
                      term={term}
                      expandedItems={expandedItems}
                      toggleItem={toggleItem}
                      onAction={onAction}
                      onContext={(x, y, item, kind) => setMenu({ x, y, target: "item", database: d.name, item, kind })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {menu?.target === "host" && (
        <GridMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={hostMenuItems(connection.kind, refresh, onAction)}
        />
      )}
      {menu?.target === "item" && (
        <GridMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={itemMenuItems(connection.kind, menu.database, menu.item, onAction)} />
      )}
    </div>
  );
}

interface ItemListProps {
  connection: ConnectionConfig;
  database: string;
  term: string;
  expandedItems: Set<string>;
  toggleItem: (key: string) => void;
  onAction: (a: TreeAction) => void;
  onContext: (x: number, y: number, item: string, kind: string) => void;
}

function ItemList({ connection, database, term, expandedItems, toggleItem, onAction, onContext }: ItemListProps) {
  const items = useQuery({
    queryKey: ["objects", connection.id, database],
    queryFn: () => api.listObjects(connection.id, database),
  });
  const isMongo = connection.kind === "mongodb";
  const sql = isSqlKind(connection.kind);

  const visible = useMemo(() => {
    const all = items.data ?? [];
    if (!term) return all;
    return all.filter((o) => o.name.toLowerCase().includes(term));
  }, [items.data, term]);

  return (
    <ul className="tree">
      {items.isLoading && <li className="muted small indent-2">loading…</li>}
      {items.isError && <li className="error small indent-2">{(items.error as Error).message}</li>}
      {items.data && items.data.length === 0 && <li className="muted small indent-2">empty</li>}
      {items.data && items.data.length > 0 && visible.length === 0 && <li className="muted small indent-2">no match</li>}
      {visible.map((o) => {
        const key = `${database}/${o.name}`;
        const expanded = expandedItems.has(key);
        const expandable = isMongo || sql;
        return (
          <li key={o.name}>
            <NodeRow
              indent={2}
              expanded={expanded}
              hasChildren={expandable}
              icon={o.kind === "view" ? "view" : o.kind === "key" ? "key" : "table"}
              label={o.name}
              kindBadge={o.kind === "view" ? "view" : undefined}
              onToggle={() => expandable && toggleItem(key)}
              onActivate={() => onAction(defaultActivate(connection.kind, database, o.name))}
              onContext={(e) => {
                e.preventDefault();
                onContext(e.clientX, e.clientY, o.name, o.kind);
              }}
            />
            {expandable && expanded && (isMongo ? (
              <ul className="tree">
                <NodeRowLeaf indent={3} icon="indexes" label="Indexes" onActivate={() => onAction({ type: "run-statement", statement: `db.${o.name}.getIndexes()`, title: `${o.name} indexes` })} />
                <NodeRowLeaf indent={3} icon="stats" label="Stats" onActivate={() => onAction({ type: "run-statement", statement: `db.${o.name}.stats()`, title: `${o.name} stats` })} />
              </ul>
            ) : (
              <ColumnList connection={connection} database={database} table={o.name} />
            ))}
          </li>
        );
      })}
      {isMongo && !term && (
        <NodeRowLeaf indent={2} icon="stats" label="DB Stats" onActivate={() => onAction({ type: "run-statement", statement: "db.stats()", title: `${database} stats` })} />
      )}
    </ul>
  );
}

function ColumnList({ connection, database, table }: { connection: ConnectionConfig; database: string; table: string }) {
  const cols = useQuery({
    queryKey: ["cols", connection.id, database, table],
    queryFn: () => api.describeObject(connection.id, database, table),
  });
  return (
    <ul className="tree">
      {cols.isLoading && <li className="muted small indent-3">loading…</li>}
      {cols.isError && <li className="error small indent-3">{(cols.error as Error).message}</li>}
      {cols.data?.map((c) => (
        <li key={c.name}>
          <div className="tree-row indent-3 leaf-row col-row" title={`${c.name} ${c.dataType}${c.nullable ? " null" : " not null"}${c.default ? ` default ${c.default}` : ""} — click to copy`} onClick={() => void copyText(c.name, `Copied "${c.name}"`)}>
            <span className="caret leaf" />
            <span className={`tree-icon ${c.primaryKey ? "i-key" : "i-col"}`} />
            <span className="tree-label">{c.name}</span>
            <span className="col-type">{shortType(c.dataType)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function defaultActivate(kind: ConnectionConfig["kind"], database: string, name: string): TreeAction {
  if (kind === "mongodb") return { type: "run-statement", statement: `db.${name}.find()`, title: name };
  // `KEY <name>` is the adapter's typed read — works for strings, hashes,
  // lists, sets alike, unlike a bare GET.
  if (kind === "redis" || kind === "dragonfly") return { type: "run-statement", statement: `KEY ${name}`, title: name };
  return { type: "browse", database, table: name };
}

type MenuItem = { sep: true } | { sep?: false; label: string; onPick: () => void; danger?: boolean };

function hostMenuItems(kind: ConnectionConfig["kind"], refresh: () => void, onAction: (a: TreeAction) => void): MenuItem[] {
  const run = (label: string, statement: string): MenuItem => ({ label, onPick: () => onAction({ type: "run-statement", statement, title: label }) });
  const base: MenuItem[] = [{ label: "Refresh schema", onPick: refresh }, { sep: true }];
  if (kind === "mongodb") {
    return [
      ...base,
      run("Server Status", "db.serverStatus()"),
      run("Host Info", "db.hostInfo()"),
      run("MongoDB Version", "db.version()"),
      { sep: true },
      run("Build Info", "db.runCommand({ buildInfo: 1 })"),
      run("List Databases", "db.runCommand({ listDatabases: 1 })"),
    ];
  }
  if (kind === "redis" || kind === "dragonfly") {
    return [...base, run("Server Info", "INFO server"), run("Memory Info", "INFO memory"), run("Stats", "INFO stats"), run("Clients", "CLIENT LIST"), run("Key count", "DBSIZE")];
  }
  const version =
    kind === "mssql"
      ? "SELECT @@VERSION AS version"
      : kind === "oracle"
        ? "SELECT banner FROM v$version WHERE ROWNUM = 1"
        : kind === "clickhouse"
          ? "SELECT version() AS version, uptime() AS uptime_seconds"
          : "SELECT version()";
  const extra: MenuItem[] =
    kind === "postgres"
      ? [run("Active queries", "SELECT pid, usename, state, now() - query_start AS running_for, left(query, 120) AS query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start"), run("Database sizes", "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC")]
      : kind === "mysql"
        ? [run("Process list", "SHOW FULL PROCESSLIST"), run("Status", "SHOW GLOBAL STATUS LIKE 'Threads%'"), run("Variables", "SHOW VARIABLES LIKE '%version%'")]
        : kind === "clickhouse"
          ? [run("Running queries", "SELECT query_id, user, elapsed, read_rows, left(query, 120) AS query FROM system.processes"), run("Disk usage", "SELECT database, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts WHERE active GROUP BY database ORDER BY sum(bytes_on_disk) DESC")]
          : [];
  return [...base, run("Server Version", version), ...extra];
}

function itemMenuItems(kind: ConnectionConfig["kind"], database: string, name: string, onAction: (a: TreeAction) => void): MenuItem[] {
  const run = (label: string, statement: string, danger = false): MenuItem => ({ label, danger, onPick: () => onAction({ type: "run-statement", statement, title: `${name} · ${label}` }) });
  const set = (label: string, statement: string, danger = false): MenuItem => ({ label, danger, onPick: () => onAction({ type: "set-statement", statement, title: `${name} · ${label}` }) });
  const exp = (format: "json" | "csv" | "xlsx"): MenuItem => ({
    label: `Export → ${format === "xlsx" ? "Excel (.xlsx)" : format.toUpperCase()}`,
    onPick: () => onAction({ type: "export", database, table: name, format }),
  });

  if (kind === "mongodb") {
    return [
      run("View Documents", `db.${name}.find()`),
      run("Count", `db.${name}.countDocuments()`),
      set("Insert Document…", `db.${name}.insertOne({\n  \n})`),
      set("Update Documents…", `db.${name}.updateMany(\n  { /* filter */ },\n  { $set: { /* fields */ } }\n)`),
      set("Remove Documents…", `db.${name}.deleteMany({ /* filter */ })`, true),
      { sep: true },
      run("Indexes", `db.${name}.getIndexes()`),
      run("Statistics", `db.${name}.stats()`),
      { sep: true },
      exp("json"),
      exp("csv"),
      exp("xlsx"),
      { sep: true },
      { label: "Copy name", onPick: () => void copyText(name) },
      set("Rename Collection…", `db.${name}.rename("new_name")`),
      set("Drop Collection…", `db.${name}.drop()`, true),
    ];
  }
  if (kind === "redis" || kind === "dragonfly") {
    return [run("View value", `KEY ${name}`), run("TYPE", `TYPE ${name}`), run("TTL", `TTL ${name}`), { sep: true }, { label: "Copy key", onPick: () => void copyText(name) }, set("DEL…", `DEL ${name}`, true)];
  }
  const ddl = buildShowCreate(kind, name);
  return [
    { label: "Browse rows", onPick: () => onAction({ type: "browse", database, table: name }) },
    run("Select 100", buildSelectStatement(kind, name, 100)),
    run("Count rows", `SELECT COUNT(*) AS total FROM ${quoteQualified(kind, name)}`),
    { sep: true },
    run("Show columns", buildShowColumns(kind, name)),
    ...(ddl ? [run("Show DDL", ddl)] : []),
    { sep: true },
    exp("json"),
    exp("csv"),
    exp("xlsx"),
    { sep: true },
    { label: "Copy quoted name", onPick: () => void copyText(quoteQualified(kind, name)) },
    set("Truncate…", `TRUNCATE TABLE ${quoteQualified(kind, name)}`, true),
    set("Drop table…", `DROP TABLE ${quoteQualified(kind, name)}`, true),
  ];
}

interface NodeRowProps {
  indent: number;
  expanded?: boolean;
  hasChildren?: boolean;
  icon: "db" | "table" | "view" | "key" | "indexes" | "stats" | "folder" | "server" | "col";
  label: string;
  kindBadge?: string;
  active?: boolean;
  onToggle?: () => void;
  onActivate?: () => void;
  onContext?: (e: React.MouseEvent) => void;
}

function NodeRow({ indent, expanded, hasChildren, icon, label, kindBadge, active, onToggle, onActivate, onContext }: NodeRowProps) {
  return (
    <div className={`tree-row indent-${indent} ${active ? "active" : ""}`} onClick={onActivate} onContextMenu={onContext} title={label}>
      <span
        className={`caret ${hasChildren ? "" : "leaf"}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
      >
        {hasChildren ? (expanded ? "▾" : "▸") : ""}
      </span>
      <span className={`tree-icon i-${icon}`} />
      <span className="tree-label">{label}</span>
      {kindBadge && <span className={`badge kind-${kindBadge}`}>{kindBadge}</span>}
      {onContext && (
        <button
          type="button"
          className="tree-row-menu"
          title="Actions"
          onClick={(e) => {
            e.stopPropagation();
            onContext(e);
          }}
        >
          ⋯
        </button>
      )}
    </div>
  );
}

function NodeRowLeaf({ indent, icon, label, onActivate }: { indent: number; icon: NodeRowProps["icon"]; label: string; onActivate: () => void }) {
  return (
    <li>
      <div className={`tree-row indent-${indent} leaf-row`} onClick={onActivate}>
        <span className="caret leaf" />
        <span className={`tree-icon i-${icon}`} />
        <span className="tree-label">{label}</span>
      </div>
    </li>
  );
}
