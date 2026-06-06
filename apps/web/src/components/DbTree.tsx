import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";

interface Props {
  connection: ConnectionConfig;
  database: string | undefined;
  setDatabase: (db: string) => void;
  /**
   * Called when the user activates a leaf or chooses an action from the
   * context menu. The Workbench drives statement insertion + tab switching.
   */
  onAction: (a: TreeAction) => void;
}

export type TreeAction =
  | { type: "browse"; database: string; table: string }
  | { type: "set-statement"; statement: string }
  | { type: "run-statement"; statement: string }
  | { type: "export"; database: string; table: string; format: "json" | "csv" | "xlsx" };

/**
 * Robo3T-style recursive tree:
 *
 *   <db>
 *   ├ <collection / table>            ← right-click for context menu
 *   │  ├ Indexes                      ← runs db.coll.getIndexes()
 *   │  └ Stats                        ← runs db.coll.stats()
 *   └ DB Stats                        ← runs db.stats()
 */
export function DbTree({ connection, database, setDatabase, onAction }: Props) {
  const qc = useQueryClient();
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(
    () => new Set(database ? [database] : []),
  );
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  // Host-root expand state — closed shows the row alone, open lists DBs.
  const [hostExpanded, setHostExpanded] = useState(true);
  // Two menu shapes: collection-level (with database+item) and host-level
  // (server actions like Host Info, Version). A single state with a target
  // discriminator keeps the open/close logic in one place.
  const [menu, setMenu] = useState<
    | { x: number; y: number; target: "host" }
    | { x: number; y: number; target: "item"; database: string; item: string }
    | null
  >(null);

  const dbs = useQuery({
    queryKey: ["dbs", connection.id],
    queryFn: () => api.listDatabases(connection.id),
  });

  // Click anywhere outside the menu closes it.
  useEffect(() => {
    if (!menu) return;
    const onDoc = () => setMenu(null);
    window.addEventListener("click", onDoc);
    window.addEventListener("contextmenu", onDoc);
    return () => {
      window.removeEventListener("click", onDoc);
      window.removeEventListener("contextmenu", onDoc);
    };
  }, [menu]);

  const toggleDb = (name: string) => {
    setExpandedDbs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setDatabase(name);
  };

  const toggleItem = (key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const dbCount = dbs.data?.length ?? 0;
  const hostLabel = `${connection.host}:${connection.port}${dbCount ? ` (${dbCount})` : ""}`;

  return (
    <div className="dbtree">
      {/* Root host row — right-click for server-level actions */}
      <NodeRow
        indent={0}
        expanded={hostExpanded}
        hasChildren
        icon="server"
        label={hostLabel}
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
                      expandedItems={expandedItems}
                      toggleItem={toggleItem}
                      onAction={onAction}
                      onContext={(x, y, item) =>
                        setMenu({ x, y, target: "item", database: d.name, item })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {menu?.target === "host" && (
        <HostContextMenu
          x={menu.x}
          y={menu.y}
          kind={connection.kind}
          onPick={(pick) => {
            setMenu(null);
            if (pick.type === "refresh") {
              qc.invalidateQueries({ queryKey: ["dbs", connection.id] });
              qc.invalidateQueries({ queryKey: ["objects", connection.id] });
              return;
            }
            onAction(pick.action);
          }}
        />
      )}
      {menu?.target === "item" && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          kind={connection.kind}
          database={menu.database}
          collection={menu.item}
          onPick={(action) => {
            setMenu(null);
            onAction(action);
          }}
        />
      )}
    </div>
  );
}

interface ItemListProps {
  connection: ConnectionConfig;
  database: string;
  expandedItems: Set<string>;
  toggleItem: (key: string) => void;
  onAction: (a: TreeAction) => void;
  onContext: (x: number, y: number, item: string) => void;
}

function ItemList({
  connection,
  database,
  expandedItems,
  toggleItem,
  onAction,
  onContext,
}: ItemListProps) {
  const items = useQuery({
    queryKey: ["objects", connection.id, database],
    queryFn: () => api.listObjects(connection.id, database),
  });

  const isMongo = connection.kind === "mongodb";

  return (
    <ul className="tree">
      {items.isLoading && <li className="muted small indent-1">loading…</li>}
      {items.isError && (
        <li className="error small indent-1">{(items.error as Error).message}</li>
      )}
      {items.data?.map((o) => {
        const key = `${database}/${o.name}`;
        const expanded = expandedItems.has(key);
        const expandable = isMongo; // collections get Indexes/Stats children
        return (
          <li key={o.name}>
            <NodeRow
              indent={1}
              expanded={expanded}
              hasChildren={expandable}
              icon={o.kind === "view" ? "view" : o.kind === "key" ? "key" : "table"}
              label={o.name}
              kindBadge={o.kind}
              onToggle={() => expandable && toggleItem(key)}
              onActivate={() => onAction(defaultActivate(connection.kind, database, o.name))}
              onContext={(e) => {
                e.preventDefault();
                onContext(e.clientX, e.clientY, o.name);
              }}
            />
            {expandable && expanded && (
              <ul className="tree">
                <NodeRowLeaf
                  indent={2}
                  icon="indexes"
                  label="Indexes"
                  onActivate={() =>
                    onAction({
                      type: "run-statement",
                      statement: `db.${o.name}.getIndexes()`,
                    })
                  }
                />
                <NodeRowLeaf
                  indent={2}
                  icon="stats"
                  label="Stats"
                  onActivate={() =>
                    onAction({
                      type: "run-statement",
                      statement: `db.${o.name}.stats()`,
                    })
                  }
                />
              </ul>
            )}
          </li>
        );
      })}
      {isMongo && (
        <NodeRowLeaf
          indent={1}
          icon="stats"
          label="DB Stats"
          onActivate={() => onAction({ type: "run-statement", statement: "db.stats()" })}
        />
      )}
    </ul>
  );
}

function defaultActivate(
  kind: ConnectionConfig["kind"],
  database: string,
  name: string,
): TreeAction {
  if (kind === "mongodb")
    return { type: "set-statement", statement: `db.${name}.find()` };
  if (kind === "redis" || kind === "dragonfly")
    return { type: "set-statement", statement: `KEY ${name}` };
  return { type: "browse", database, table: name };
}

/**
 * Quote a SQL table identifier per dialect. Critical for Postgres / Oracle
 * which fold unquoted identifiers to lowercase — `SELECT * FROM AuditLog`
 * silently becomes `auditlog` and fails when the actual table is mixed-case
 * (very common with Prisma / TypeORM-managed schemas).
 */
function quoteSqlTable(kind: ConnectionConfig["kind"], name: string): string {
  // Schema-qualified names come in as "schema.table" — split so each part
  // gets its own quote pair instead of producing the invalid "schema.table".
  const dot = name.indexOf(".");
  const [schema, table] =
    dot === -1 ? [null, name] : [name.slice(0, dot), name.slice(dot + 1)];

  if (kind === "mssql") {
    const wrap = (s: string) => `[${s.replace(/]/g, "]]")}]`;
    return schema ? `${wrap(schema)}.${wrap(table)}` : wrap(table);
  }
  if (kind === "postgres" || kind === "oracle") {
    const wrap = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return schema ? `${wrap(schema)}.${wrap(table)}` : wrap(table);
  }
  // mysql / mariadb
  const wrap = (s: string) => `\`${s.replace(/`/g, "``")}\``;
  return schema ? `${wrap(schema)}.${wrap(table)}` : wrap(table);
}

function buildSelectStatement(
  kind: ConnectionConfig["kind"],
  table: string,
  limit: number,
): string {
  const t = quoteSqlTable(kind, table);
  if (kind === "mssql") return `SELECT TOP ${limit} * FROM ${t}`;
  if (kind === "oracle") return `SELECT * FROM ${t} FETCH FIRST ${limit} ROWS ONLY`;
  return `SELECT * FROM ${t} LIMIT ${limit}`;
}

/**
 * Per-dialect "describe table" query. Each engine has its own catalog —
 * keeping this kind-aware avoids the user having to remember which one
 * applies to which DB.
 */
function buildShowColumns(
  kind: ConnectionConfig["kind"],
  qualified: string,
): string {
  const dot = qualified.indexOf(".");
  const [schema, table] =
    dot === -1 ? [null, qualified] : [qualified.slice(0, dot), qualified.slice(dot + 1)];
  const escTable = table.replace(/'/g, "''");
  const escSchema = (schema ?? "public").replace(/'/g, "''");

  if (kind === "mysql") {
    return `SHOW COLUMNS FROM ${quoteSqlTable(kind, qualified)}`;
  }
  if (kind === "clickhouse") {
    return `DESCRIBE TABLE ${quoteSqlTable(kind, qualified)}`;
  }
  if (kind === "postgres") {
    return `SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = '${escSchema}' AND table_name = '${escTable}'
ORDER BY ordinal_position`;
  }
  if (kind === "mssql") {
    return `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = '${escTable}'
ORDER BY ORDINAL_POSITION`;
  }
  if (kind === "oracle") {
    return `SELECT column_name, data_type, nullable, data_default
FROM all_tab_columns
WHERE owner = '${escSchema.toUpperCase()}' AND table_name = '${escTable.toUpperCase()}'
ORDER BY column_id`;
  }
  return `SELECT * FROM ${quoteSqlTable(kind, qualified)} LIMIT 0`;
}

interface NodeRowProps {
  indent: number;
  expanded?: boolean;
  hasChildren?: boolean;
  icon: "db" | "table" | "view" | "key" | "indexes" | "stats" | "folder" | "server";
  label: string;
  kindBadge?: string;
  active?: boolean;
  onToggle?: () => void;
  onActivate?: () => void;
  onContext?: (e: React.MouseEvent) => void;
}

function NodeRow({
  indent,
  expanded,
  hasChildren,
  icon,
  label,
  kindBadge,
  active,
  onToggle,
  onActivate,
  onContext,
}: NodeRowProps) {
  return (
    <div
      className={`tree-row indent-${indent} ${active ? "active" : ""}`}
      onClick={onActivate}
      onContextMenu={onContext}
    >
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
      {kindBadge && icon !== "table" && <span className={`badge kind-${kindBadge}`}>{kindBadge}</span>}
      {/* Same actions as right-click, but discoverable via a hover-revealed
          `⋯` trigger — most users don't know to right-click on a tree row,
          and Export → Excel etc. used to be hidden behind that gesture. */}
      {onContext && (
        <button
          type="button"
          className="tree-row-menu"
          title="More actions"
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

function NodeRowLeaf({
  indent,
  icon,
  label,
  onActivate,
}: {
  indent: number;
  icon: NodeRowProps["icon"];
  label: string;
  onActivate: () => void;
}) {
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

interface ContextMenuProps {
  x: number;
  y: number;
  kind: ConnectionConfig["kind"];
  database: string;
  collection: string;
  onPick: (a: TreeAction) => void;
}

/** Host-level (connection-root) context menu items emit either a tree action
 *  or a "refresh" pseudo-action that the parent re-invalidates the cache with. */
type HostMenuPick =
  | { type: "refresh" }
  | { type: "action"; action: TreeAction };

interface HostContextMenuProps {
  x: number;
  y: number;
  kind: ConnectionConfig["kind"];
  onPick: (p: HostMenuPick) => void;
}

function HostContextMenu({ x, y, kind, onPick }: HostContextMenuProps) {
  // Per-DBMS server actions — Mongo gets the full Robo3T-style list, others
  // a minimal Refresh + version probe.
  const items: { label: string; pick: HostMenuPick; sep?: boolean; danger?: boolean }[] =
    kind === "mongodb"
      ? [
          { label: "Refresh", pick: { type: "refresh" } },
          { sep: true, label: "", pick: { type: "refresh" } },
          {
            label: "Server Status",
            pick: { type: "action", action: { type: "run-statement", statement: "db.serverStatus()" } },
          },
          {
            label: "Host Info",
            pick: { type: "action", action: { type: "run-statement", statement: "db.hostInfo()" } },
          },
          {
            label: "MongoDB Version",
            pick: { type: "action", action: { type: "run-statement", statement: "db.version()" } },
          },
          { sep: true, label: "", pick: { type: "refresh" } },
          {
            label: "Build Info",
            pick: { type: "action", action: { type: "run-statement", statement: "db.runCommand({ buildInfo: 1 })" } },
          },
          {
            label: "List Databases",
            pick: { type: "action", action: { type: "run-statement", statement: "db.runCommand({ listDatabases: 1 })" } },
          },
        ]
      : kind === "redis" || kind === "dragonfly"
        ? [
            { label: "Refresh", pick: { type: "refresh" } },
            { sep: true, label: "", pick: { type: "refresh" } },
            {
              label: "Server Info",
              pick: { type: "action", action: { type: "run-statement", statement: "INFO server" } },
            },
            {
              label: "Memory Info",
              pick: { type: "action", action: { type: "run-statement", statement: "INFO memory" } },
            },
            {
              label: "Stats",
              pick: { type: "action", action: { type: "run-statement", statement: "INFO stats" } },
            },
          ]
        : [
            { label: "Refresh", pick: { type: "refresh" } },
            { sep: true, label: "", pick: { type: "refresh" } },
            {
              label: "Server Version",
              pick: {
                type: "action",
                action: {
                  type: "run-statement",
                  statement:
                    kind === "mssql"
                      ? "SELECT @@VERSION AS version"
                      : kind === "oracle"
                        ? "SELECT banner FROM v$version WHERE ROWNUM = 1"
                        : kind === "clickhouse"
                          ? "SELECT version() AS version, uptime() AS uptime_seconds"
                          : "SELECT version()",
                },
              },
            },
          ];

  return (
    <div
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="context-sep" />
        ) : (
          <div
            key={i}
            className={`context-item ${it.danger ? "danger" : ""}`}
            onClick={() => onPick(it.pick)}
          >
            {it.label}
          </div>
        ),
      )}
    </div>
  );
}

function ContextMenu({ x, y, kind, collection, onPick, database }: ContextMenuProps) {
  // Items per kind. We auto-run "view" type actions and just paste insert/
  // update templates so the user can fill in args.
  const items: { label: string; action: TreeAction; danger?: boolean; sep?: boolean }[] =
    kind === "mongodb"
      ? [
          { label: "View Documents", action: { type: "run-statement", statement: `db.${collection}.find()` } },
          {
            label: "Insert Document…",
            action: {
              type: "set-statement",
              statement: `db.${collection}.insertOne({\n  \n})`,
            },
          },
          {
            label: "Update Documents…",
            action: {
              type: "set-statement",
              statement: `db.${collection}.updateMany(\n  { /* filter */ },\n  { $set: { /* fields */ } }\n)`,
            },
          },
          {
            label: "Remove Documents…",
            action: {
              type: "set-statement",
              statement: `db.${collection}.deleteMany({ /* filter */ })`,
            },
            danger: true,
          },
          { sep: true, label: "", action: { type: "set-statement", statement: "" } },
          { label: "Indexes", action: { type: "run-statement", statement: `db.${collection}.getIndexes()` } },
          { label: "Statistics", action: { type: "run-statement", statement: `db.${collection}.stats()` } },
          { sep: true, label: "", action: { type: "set-statement", statement: "" } },
          { label: "Export → JSON", action: { type: "export", database, table: collection, format: "json" } },
          { label: "Export → CSV", action: { type: "export", database, table: collection, format: "csv" } },
          { label: "Export → Excel (.xlsx)", action: { type: "export", database, table: collection, format: "xlsx" } },
          { sep: true, label: "", action: { type: "set-statement", statement: "" } },
          {
            label: "Rename Collection…",
            action: {
              type: "set-statement",
              statement: `db.${collection}.rename("new_name")`,
            },
          },
          {
            label: "Drop Collection…",
            action: { type: "set-statement", statement: `db.${collection}.drop()` },
            danger: true,
          },
        ]
      : [
          {
            label: "Browse rows",
            action: { type: "browse", database, table: collection },
          },
          {
            label: "Select 100",
            action: {
              type: "run-statement",
              statement: buildSelectStatement(kind, collection, 100),
            },
          },
          {
            label: "Insert quoted name",
            action: {
              type: "set-statement",
              statement: quoteSqlTable(kind, collection),
            },
          },
          { sep: true, label: "", action: { type: "set-statement", statement: "" } },
          {
            label: "Show columns",
            action: {
              type: "run-statement",
              statement: buildShowColumns(kind, collection),
            },
          },
          {
            label: "Count rows",
            action: {
              type: "run-statement",
              statement: `SELECT COUNT(*) FROM ${quoteSqlTable(kind, collection)}`,
            },
          },
          { sep: true, label: "", action: { type: "set-statement", statement: "" } },
          { label: "Export → JSON", action: { type: "export", database, table: collection, format: "json" } },
          { label: "Export → CSV", action: { type: "export", database, table: collection, format: "csv" } },
          { label: "Export → Excel (.xlsx)", action: { type: "export", database, table: collection, format: "xlsx" } },
        ];

  // The Mongo flavor of this menu is ~14 items tall (~420px). Right-clicking
  // anywhere in the lower half of a tall sidebar would push the bottom items
  // — including Export → Excel — past the viewport bottom and out of view.
  // Measure after mount, then clamp the position to keep the entire menu
  // within the viewport (with a small inset for breathing room).
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (left !== x || top !== y) setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="context-sep" />
        ) : (
          <div
            key={i}
            className={`context-item ${it.danger ? "danger" : ""}`}
            onClick={() => onPick(it.action)}
          >
            {it.label}
          </div>
        ),
      )}
    </div>
  );
}
