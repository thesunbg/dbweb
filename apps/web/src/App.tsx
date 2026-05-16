import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig, DbKind } from "@dbweb/shared-types";
import { api } from "./api.js";
import { ConnectionForm } from "./components/ConnectionForm.js";
import { Workbench } from "./components/Workbench.js";
import { PortabilityModal } from "./components/PortabilityModal.js";

/** Two-letter glyph per DB kind — compact enough to fit in a 24px square
 *  badge while staying unambiguous (single-letter "M" would clash between
 *  MySQL and MongoDB). Color comes from the per-kind class in styles.css. */
const KIND_GLYPH: Record<DbKind, string> = {
  mysql: "My",
  postgres: "Pg",
  oracle: "Or",
  mssql: "Ms",
  mongodb: "Mo",
  redis: "Rd",
  dragonfly: "Df",
  clickhouse: "Ch",
};

export function App() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [showPort, setShowPort] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The row whose `⋯` overflow menu is open. Only one row's menu is open at
  // a time; clicking outside or selecting an action closes it.
  const [menuFor, setMenuFor] = useState<string | null>(null);
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
          <ul>
            {connections.data?.map((c) => (
              <li
                key={c.id}
                className={`conn-item ${selectedId === c.id ? "active" : ""}`}
                onClick={() => setSelectedId(c.id)}
                title={`${c.kind} · ${c.host}:${c.port}`}
              >
                <span
                  className={`conn-icon kind-${c.kind}`}
                  title={c.kind}
                  aria-label={c.kind}
                >
                  {KIND_GLYPH[c.kind]}
                </span>
                <span
                  className={`conn-status ${activeSet.has(c.id) ? "live" : "idle"}`}
                  title={activeSet.has(c.id) ? "connected" : "not connected"}
                />
                <span className="conn-name">{c.name}</span>
                <ConnMenu
                  open={menuFor === c.id}
                  onToggle={() => setMenuFor((m) => (m === c.id ? null : c.id))}
                  onClose={() => setMenuFor(null)}
                  onCopyUrl={async () => {
                    try {
                      const { url } = await api.connectionUrl(c.id);
                      await navigator.clipboard.writeText(url);
                    } catch (err) {
                      alert(`Copy failed: ${(err as Error).message}`);
                    }
                  }}
                  onEdit={() => {
                    setEditing(c);
                    setShowForm(true);
                  }}
                  onDelete={() => {
                    if (confirm(`Delete connection "${c.name}"?`)) remove.mutate(c.id);
                  }}
                />
              </li>
            ))}
          </ul>
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
    </div>
  );
}

interface ConnMenuProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onCopyUrl: () => void | Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * Per-row overflow menu. Renders a single `⋯` trigger that, when clicked,
 * pops up a small list of actions (Copy URL / Edit / Delete). Closes on
 * outside click, Escape, or after any action runs.
 *
 * The trigger lives inside the conn-item row, so we stop propagation on
 * every click — otherwise tapping anywhere on the menu would also fire the
 * row's `onClick` and switch the active connection.
 */
function ConnMenu({ open, onToggle, onClose, onCopyUrl, onEdit, onDelete }: ConnMenuProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={wrapRef} className="conn-menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`ghost icon conn-menu-trigger ${open ? "open" : ""}`}
        title="More actions"
        onClick={onToggle}
      >
        ⋯
      </button>
      {open && (
        <div className="conn-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              await onCopyUrl();
              setCopied(true);
              // Brief confirmation flash before the menu auto-closes — the
              // user expects feedback but doesn't need a separate toast.
              setTimeout(() => {
                setCopied(false);
                onClose();
              }, 700);
            }}
          >
            {copied ? "✓ Copied" : "Copy URL"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onEdit();
              onClose();
            }}
          >
            Edit
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
