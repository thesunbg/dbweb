import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "./api.js";
import { ConnectionForm } from "./components/ConnectionForm.js";
import { ConnectionList } from "./components/ConnectionList.js";
import { Workbench, Divider } from "./components/Workbench.js";
import { PortabilityModal } from "./components/PortabilityModal.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { SnippetsModal } from "./components/SnippetsModal.js";
import { AlertsPopover } from "./components/AlertsPopover.js";
import { useInstallPrompt } from "./lib/pwa.js";
import { KIND_LABEL, KIND_ORDER } from "./lib/kinds.js";
import { readFlag, readPref, writeFlag, writePref } from "./lib/prefs.js";
import { Modal, UiHost, confirmDialog, toast } from "./lib/ui.js";
import { useTheme } from "./lib/theme.js";

export function App() {
  const qc = useQueryClient();
  const { canInstall, install } = useInstallPrompt();
  const { theme, toggle: toggleTheme } = useTheme();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [showPort, setShowPort] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [exportScope, setExportScope] = useState<{ id: string; name: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => readPref<string | null>("selectedConnection", null));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readFlag("sidebarCollapsed"));
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readPref("sidebarWidth", 280));

  const select = (id: string | null) => {
    setSelectedId(id);
    writePref("selectedConnection", id);
  };

  const toggleSidebar = () =>
    setSidebarCollapsed((prev) => {
      writeFlag("sidebarCollapsed", !prev);
      return !prev;
    });

  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const active = useQuery({
    queryKey: ["active-connections"],
    queryFn: api.activeConnections,
    refetchInterval: 5_000,
    staleTime: 0,
  });
  const activeSet = new Set(active.data?.ids ?? []);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      if (selectedId === id) select(null);
      toast.success("Connection deleted");
    },
    onError: (err) => toast.error(`Delete failed: ${(err as Error).message}`),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateConnection(id),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      select(created.id);
      toast.success(`Duplicated as "${created.name}"`);
    },
    onError: (err) => toast.error(`Duplicate failed: ${(err as Error).message}`),
  });

  const selected = connections.data?.find((c) => c.id === selectedId) ?? null;

  // Global shortcuts that aren't owned by a specific component.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setEditing(null);
        setShowForm(true);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "?" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !document.activeElement?.closest(".monaco-editor")) {
        setShowHelp(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setEditing(null);
    setShowForm(true);
  };

  return (
    <div className={`layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={!sidebarCollapsed ? { gridTemplateColumns: `${sidebarWidth}px 4px 1fr` } : undefined}>
      {sidebarCollapsed ? (
        <aside className="sidebar collapsed">
          <button type="button" className="sidebar-rail-toggle" onClick={toggleSidebar} title="Show connections (⌘\)">
            ›
          </button>
          {connections.data?.slice(0, 12).map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conn-icon rail-icon kind-${c.kind} ${c.id === selectedId ? "active" : ""} ${c.color ? `accent-${c.color}` : ""}`}
              title={c.name}
              onClick={() => select(c.id)}
            >
              {KIND_LABEL[c.kind].glyph}
            </button>
          ))}
          <div className="grow" />
          <span className={`status-dot ${health.isSuccess ? "ok" : "down"}`} title={health.isSuccess ? "server online" : "server offline"} />
        </aside>
      ) : (
        <>
          <aside className="sidebar">
            <div className="sidebar-header">
              <h1>dbweb</h1>
              <span className={`status ${health.isSuccess ? "ok" : "down"}`}>{health.isSuccess ? "online" : "offline"}</span>
              <div className="grow" />
              {canInstall && (
                <button type="button" className="ghost install-app" onClick={() => void install()} title="Install dbweb as a standalone app (Chrome)">
                  ⤓ Install
                </button>
              )}
              <button type="button" className="ghost icon-btn" onClick={toggleSidebar} title="Hide sidebar (⌘\)">
                ‹
              </button>
            </div>

            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <span>Connections{connections.data ? ` · ${connections.data.length}` : ""}</span>
                <div className="row-tight">
                  <button type="button" className="ghost icon-btn" onClick={() => setShowPort(true)} title="Export / Import connections">
                    ⇅
                  </button>
                  <button type="button" className="primary tiny" onClick={openNew} title="New connection (⌥⌘N)">
                    + New
                  </button>
                </div>
              </div>
              {connections.isLoading && <div className="muted hint">Loading…</div>}
              {connections.isError && <div className="error">{(connections.error as Error).message}</div>}
              {connections.data && connections.data.length === 0 && (
                <div className="muted hint sidebar-empty">
                  No connections yet.
                  <button type="button" className="link" onClick={openNew}>
                    Create the first one
                  </button>
                </div>
              )}
              {connections.data && connections.data.length > 0 && (
                <ConnectionList
                  connections={connections.data}
                  activeIds={activeSet}
                  selectedId={selectedId}
                  onSelect={select}
                  onEdit={(c) => {
                    setEditing(c);
                    setShowForm(true);
                  }}
                  onDuplicate={(id) => duplicate.mutate(id)}
                  onExport={(c) => setExportScope({ id: c.id, name: c.name })}
                  onDelete={async (c) => {
                    const ok = await confirmDialog({
                      title: `Delete "${c.name}"?`,
                      message: "The saved password, query history and saved queries for this connection are removed too.",
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (ok) remove.mutate(c.id);
                  }}
                />
              )}
            </div>
          </aside>
          <Divider
            axis="x"
            onDrag={(dx) =>
              setSidebarWidth((w) => {
                const next = Math.max(200, Math.min(480, w + dx));
                writePref("sidebarWidth", next);
                return next;
              })
            }
          />
        </>
      )}

      <main className="main">
        {selected ? (
          <Workbench
            connection={selected}
            connections={connections.data ?? []}
            key={selected.id}
            onEditConnection={() => {
              setEditing(selected);
              setShowForm(true);
            }}
            onOpenSettings={() => setShowSettings(true)}
          />
        ) : (
          <div className="empty-state">
            <div className="empty-logo">db</div>
            <h2>{connections.data && connections.data.length > 0 ? "Pick a connection to start" : "Welcome to dbweb"}</h2>
            <p className="muted">
              {connections.data && connections.data.length > 0
                ? "Choose one from the sidebar, or create a new one."
                : "A local-first workbench for all your databases. Add your first connection to get going."}
            </p>
            <div className="row-tight" style={{ justifyContent: "center", gap: 8 }}>
              <button type="button" className="primary" onClick={openNew}>
                + New connection
              </button>
              <button type="button" className="ghost" onClick={() => setShowPort(true)}>
                Import bundle
              </button>
            </div>
            <div className="kind-cloud">
              {KIND_ORDER.map((k) => (
                <span key={k} className={`kind-chip kind-${k}`}>
                  <span className="conn-icon">{KIND_LABEL[k].glyph}</span>
                  {KIND_LABEL[k].label}
                </span>
              ))}
            </div>
            <div className="muted hint shortcut-hints">
              <kbd>⌥⌘N</kbd> new connection · <kbd>⌘K</kbd> search · <kbd>⌘\</kbd> toggle sidebar · <kbd>?</kbd> all shortcuts
            </div>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span className="row-tight">
          <span className={`status-dot ${health.isSuccess ? "ok" : "down"}`} />
          <span>{health.data ? `server ${health.data.version}` : "server offline"}</span>
        </span>
        {selected && (
          <span className="muted">
            {KIND_LABEL[selected.kind].label} · {selected.host}:{selected.port}
            {activeSet.has(selected.id) ? " · connected" : ""}
          </span>
        )}
        <div className="grow" />
        <AlertsPopover onSelectConnection={select} />
        <button type="button" className="statusbar-btn" onClick={() => setShowSnippets(true)} title="Snippet library">
          ✂ Snippets
        </button>
        <button type="button" className="statusbar-btn" onClick={() => setShowSettings(true)} title="Settings (AI key, model)">
          ⚙ Settings
        </button>
        <button type="button" className="statusbar-btn" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (?)">
          ? Shortcuts
        </button>
        <button type="button" className="statusbar-btn" onClick={toggleTheme} title="Toggle light / dark">
          {theme === "dark" ? "☾ Dark" : "☼ Light"}
        </button>
      </footer>

      {showForm && (
        <ConnectionForm
          editing={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={(conn) => {
            if (!editing) select(conn.id);
          }}
        />
      )}
      {showPort && <PortabilityModal onClose={() => setShowPort(false)} />}
      {exportScope && <PortabilityModal scope={exportScope} onClose={() => setExportScope(null)} />}
      {showHelp && <ShortcutsModal onClose={() => setShowHelp(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showSnippets && <SnippetsModal onClose={() => setShowSnippets(false)} />}
      <UiHost />
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["⌘ ⏎", "Run query (or only the highlighted selection)"],
    ["⌘ S", "Save current query"],
    ["⌥ ⌘ T", "New query tab"],
    ["⌥ ⌘ N", "New connection"],
    ["⌘ K", "Search connections"],
    ["⌘ ⇧ F", "Find a column or table in the current database"],
    ["⌘ ⇧ I", "Toggle the AI assistant"],
    ["⌘ \\", "Toggle sidebar"],
    ["Esc", "Close dialogs / clear search"],
    ["↑ ↓ ← →", "Move between result cells (after clicking one)"],
    ["⏎ on a cell", "Open / edit the cell"],
    ["⌘ C on a cell", "Copy cell value"],
    ["Double-click tab", "Rename query tab"],
    ["Middle-click tab", "Close tab"],
    ["Right-click", "Context menu on tree rows and result cells"],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={480}>
      <table className="shortcut-table">
        <tbody>
          {rows.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted hint">On Windows / Linux use Ctrl instead of ⌘.</p>
    </Modal>
  );
}
