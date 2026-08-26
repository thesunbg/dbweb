import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "./api.js";
import { ConnectionForm } from "./components/ConnectionForm.js";
import { ConnectionList } from "./components/ConnectionList.js";
import { Workbench } from "./components/Workbench.js";
import { PortabilityModal } from "./components/PortabilityModal.js";
import { useInstallPrompt } from "./lib/pwa.js";

export function App() {
  const qc = useQueryClient();
  const { canInstall, install } = useInstallPrompt();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [showPort, setShowPort] = useState(false);
  // When set, the portability modal opens scoped to a single connection
  // (Export… from the ⋯ menu). Null means the bulk ⇅ flow.
  const [exportScope, setExportScope] = useState<{ id: string; name: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("dbweb:sidebarCollapsed") === "1",
  );

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("dbweb:sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  };

  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  // Poll the live-adapter set so each row's status dot stays accurate as
  // adapters get reaped (5-min idle) or freshly opened.
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
      if (selectedId === id) setSelectedId(null);
    },
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateConnection(id),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      // Select the freshly-created copy so the user sees the result land.
      setSelectedId(created.id);
    },
    onError: (err) => alert(`Duplicate failed: ${(err as Error).message}`),
  });

  const selected = connections.data?.find((c) => c.id === selectedId) ?? null;

  if (sidebarCollapsed) {
    // Compact rail: just an expand button + tiny health dot. The rest of the
    // viewport goes to the workbench, which is what users want when they're
    // deep inside a single DB session.
    return (
      <div className="layout sidebar-collapsed">
        <aside className="sidebar collapsed">
          <button
            type="button"
            className="sidebar-rail-toggle"
            onClick={toggleSidebar}
            title="Expand connections"
          >
            ›
          </button>
          <span className={`status-dot ${health.isSuccess ? "ok" : "down"}`} title={health.isSuccess ? "online" : "offline"} />
        </aside>

        <main className="main">
          {selected ? (
            <Workbench connection={selected} key={selected.id} />
          ) : (
            <div className="empty-state">
              <h2>Expand sidebar to choose a connection</h2>
            </div>
          )}
        </main>

        <footer className="statusbar">
          <span>v0.1.0</span>
          <span>{health.data ? `server ${health.data.version}` : "—"}</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>dbweb</h1>
          <span className={`status ${health.isSuccess ? "ok" : "down"}`}>
            {health.isSuccess ? "online" : "offline"}
          </span>
          {canInstall && (
            <button
              type="button"
              className="ghost install-app"
              onClick={() => void install()}
              title="Cài dbweb thành app riêng (Chrome)"
            >
              ⤓ Install
            </button>
          )}
          <button
            type="button"
            className="ghost icon"
            onClick={toggleSidebar}
            title="Collapse sidebar"
          >
            ‹
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span>Connections</span>
            <div className="row-tight">
              <button
                type="button"
                className="ghost"
                onClick={() => setShowPort(true)}
                title="Export / Import"
              >
                ⇅
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditing(null);
                  setShowForm(true);
                }}
                title="New connection"
              >
                +
              </button>
            </div>
          </div>
          {connections.isLoading && <div className="muted">Loading...</div>}
          {connections.isError && <div className="error">{(connections.error as Error).message}</div>}
          {connections.data && connections.data.length === 0 && (
            <div className="muted">Chưa có connection nào.</div>
          )}
          {connections.data && connections.data.length > 0 && (
            <ConnectionList
              connections={connections.data}
              activeIds={activeSet}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onEdit={(c) => {
                setEditing(c);
                setShowForm(true);
              }}
              onDuplicate={(id) => duplicate.mutate(id)}
              onExport={(c) => setExportScope({ id: c.id, name: c.name })}
              onDelete={(c) => {
                if (confirm(`Delete connection "${c.name}"?`)) remove.mutate(c.id);
              }}
            />
          )}
        </div>
      </aside>

      <main className="main">
        {selected ? (
          <Workbench connection={selected} key={selected.id} />
        ) : (
          <div className="empty-state">
            <h2>Chọn 1 connection bên trái</h2>
            <p className="muted">
              Hoặc bấm <strong>+</strong> để tạo mới. Hỗ trợ MySQL, Postgres, Oracle, MSSQL, MongoDB, Redis.
            </p>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span>v0.1.0</span>
        <span>{health.data ? `server ${health.data.version}` : "—"}</span>
      </footer>

      {showForm && (
        <ConnectionForm
          editing={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}
      {showPort && <PortabilityModal onClose={() => setShowPort(false)} />}
      {exportScope && (
        <PortabilityModal scope={exportScope} onClose={() => setExportScope(null)} />
      )}
    </div>
  );
}
