import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig, ConnectionInput, DbKind } from "@dbweb/shared-types";
import { api } from "../api.js";
import { buildConnectionUrl, parseConnectionUrl } from "../lib/connection-url.js";

const DEFAULT_PORTS: Record<DbKind, number> = {
  mysql: 3306,
  postgres: 5432,
  oracle: 1521,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
  dragonfly: 6379,
  clickhouse: 8123,
};

interface Props {
  editing?: ConnectionConfig | null;
  onClose: () => void;
}

export function ConnectionForm({ editing, onClose }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ConnectionInput>(
    editing
      ? {
          name: editing.name,
          kind: editing.kind,
          host: editing.host,
          port: editing.port,
          username: editing.username ?? "",
          password: "",
          database: editing.database ?? "",
          group: editing.group ?? "",
          options: editing.options,
        }
      : {
          name: "",
          kind: "mysql",
          host: "127.0.0.1",
          port: DEFAULT_PORTS.mysql,
          username: "",
          password: "",
          database: "",
          group: "",
        },
  );

  // Already in cache — the sidebar keeps this query warm. Used to offer the
  // existing group names as autocomplete instead of making the user retype.
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const groupNames = [
    ...new Set(
      (connections.data ?? [])
        .map((c) => c.group?.trim())
        .filter((g): g is string => Boolean(g)),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const create = useMutation({
    mutationFn: (input: ConnectionInput) =>
      editing
        ? api.updateConnection(editing.id, sanitizePatch(input))
        : api.createConnection(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      onClose();
    },
  });

  // Paste-URL state. Populated from the live form so editing fields keeps the
  // preview in sync; pasting a new URL re-fills the form.
  const [urlInput, setUrlInput] = useState<string>("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const onPasteUrl = (raw: string) => {
    setUrlInput(raw);
    if (!raw.trim()) {
      setUrlError(null);
      return;
    }
    const parsed = parseConnectionUrl(raw);
    if (!parsed) {
      setUrlError("Unrecognised URL — check the scheme (postgres / mysql / mongodb / redis / mssql / oracle).");
      return;
    }
    setUrlError(null);
    setForm((f) => ({
      // Keep the current name unless empty — users often type the friendly
      // name first, then paste the URL.
      name: f.name || `${parsed.kind}@${parsed.host}`,
      kind: parsed.kind,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username ?? "",
      password: parsed.password ?? "",
      database: parsed.database ?? "",
      group: f.group,
      options: parsed.options,
    }));
  };

  const setKind = (kind: DbKind) =>
    setForm((f) => ({ ...f, kind, port: DEFAULT_PORTS[kind] }));

  // For an edit, an empty password means "keep the existing one" — drop the
  // field so the PATCH doesn't overwrite the stored value with "".
  function sanitizePatch(input: ConnectionInput): Partial<ConnectionInput> {
    const out: Partial<ConnectionInput> = { ...input };
    if (!input.password) delete out.password;
    return out;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{editing ? `Edit connection: ${editing.name}` : "New connection"}</h3>
          <button type="button" className="ghost" onClick={onClose}>×</button>
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form);
          }}
        >
          <label>
            <span>Paste connection URL (optional)</span>
            <textarea
              rows={2}
              value={urlInput}
              onChange={(e) => onPasteUrl(e.target.value)}
              placeholder="postgres://user:pass@host:5432/db   |   DATABASE_URL=mongodb://...   |   mysql://..."
              spellCheck={false}
            />
            {urlError && <span className="error small">{urlError}</span>}
          </label>

          <label>
            <span>Name</span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="prod-mysql"
            />
          </label>

          <label>
            <span>Kind</span>
            <select value={form.kind} onChange={(e) => setKind(e.target.value as DbKind)}>
              <option value="mysql">MySQL</option>
              <option value="postgres">Postgres</option>
              <option value="oracle">Oracle</option>
              <option value="mssql">MSSQL</option>
              <option value="mongodb">MongoDB</option>
              <option value="redis">Redis</option>
              <option value="dragonfly">Dragonfly</option>
              <option value="clickhouse">ClickHouse</option>
            </select>
          </label>

          <div className="row">
            <label className="grow">
              <span>Host</span>
              <input
                required
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
            </label>
            <label>
              <span>Port</span>
              <input
                required
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="row">
            <label className="grow">
              <span>Username</span>
              <input
                value={form.username ?? ""}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </label>
            <label className="grow">
              <span>Password{editing && " (leave blank to keep)"}</span>
              <input
                type="password"
                value={form.password ?? ""}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
          </div>

          <div className="row">
            <label className="grow">
              <span>Database (optional)</span>
              <input
                value={form.database ?? ""}
                onChange={(e) => setForm({ ...form, database: e.target.value })}
                placeholder="leave blank to choose later"
              />
            </label>
            <label className="grow">
              <span>Group (optional)</span>
              <input
                list="dbweb-groups"
                value={form.group ?? ""}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
                placeholder="Coolify, Production…"
              />
              <datalist id="dbweb-groups">
                {groupNames.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
          </div>

          {/* Reverse URL preview — what this connection looks like as an env var.
              Helps double-check that the form mirrors the pasted URL. */}
          {form.host && (
            <div className="url-preview">
              <span className="muted small">Equivalent URL</span>
              <div className="row-tight">
                <code className="url-code">{buildConnectionUrl(form)}</code>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => navigator.clipboard.writeText(buildConnectionUrl(form))}
                  title="Copy to clipboard"
                >
                  ⧉
                </button>
              </div>
            </div>
          )}

          {create.isError && (
            <div className="error">{(create.error as Error).message}</div>
          )}

          <div className="modal-footer">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={create.isPending}>
              {create.isPending ? "Saving..." : editing ? "Update" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
