import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig, ConnectionInput, DbKind } from "@dbweb/shared-types";
import { api } from "../api.js";

const DEFAULT_PORTS: Record<DbKind, number> = {
  mysql: 3306,
  postgres: 5432,
  oracle: 1521,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
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
        },
  );

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

          <label>
            <span>Database (optional)</span>
            <input
              value={form.database ?? ""}
              onChange={(e) => setForm({ ...form, database: e.target.value })}
              placeholder="leave blank to choose later"
            />
          </label>

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
