import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionColor, ConnectionConfig, ConnectionInput, DbKind } from "@dbweb/shared-types";
import { api, type PingResult } from "../api.js";
import { buildConnectionUrl, parseConnectionUrl } from "../lib/connection-url.js";
import { COLOR_LABEL, KIND_LABEL, KIND_ORDER } from "../lib/kinds.js";
import { shortVersion } from "../lib/format.js";
import { Modal, copyText, toast } from "../lib/ui.js";

const COLORS: { value: ConnectionColor | ""; label: string }[] = [
  { value: "", label: "None" },
  ...(Object.entries(COLOR_LABEL) as [ConnectionColor, string][]).map(([value, label]) => ({ value, label })),
];

interface Props {
  editing?: ConnectionConfig | null;
  onClose: () => void;
  onSaved?: (conn: ConnectionConfig) => void;
}

export function ConnectionForm({ editing, onClose, onSaved }: Props) {
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
          color: editing.color ?? null,
          readOnly: editing.readOnly ?? false,
          ssh: editing.ssh ? { host: editing.ssh.host, port: editing.ssh.port, username: editing.ssh.username } : null,
          options: editing.options,
        }
      : {
          name: "",
          kind: "postgres",
          host: "127.0.0.1",
          port: KIND_LABEL.postgres.port,
          username: "",
          password: "",
          database: "",
          group: "",
          color: null,
          readOnly: false,
          ssh: null,
        },
  );
  const [sshOpen, setSshOpen] = useState<boolean>(!!editing?.ssh?.host);
  const [sshAuth, setSshAuth] = useState<"password" | "key">("password");
  const [showPassword, setShowPassword] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: true; ping: PingResult } | { ok: false; message: string } | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const connections = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const groupNames = [...new Set((connections.data ?? []).map((c) => c.group?.trim()).filter((g): g is string => Boolean(g)))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  const save = useMutation({
    mutationFn: (input: ConnectionInput) => (editing ? api.updateConnection(editing.id, sanitizePatch(input)) : api.createConnection(input)),
    onSuccess: (conn) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.removeQueries({ queryKey: ["ping", conn.id] });
      toast.success(editing ? "Connection updated" : "Connection created");
      onSaved?.(conn);
      onClose();
    },
  });

  const test = useMutation({
    mutationFn: () => api.testConfig({ ...normalize(form), id: editing?.id }),
    onSuccess: (ping) => setTestResult({ ok: true, ping }),
    onError: (e) => setTestResult({ ok: false, message: (e as Error).message }),
  });

  // Any edit invalidates the last test result — it no longer describes
  // what's in the form.
  const patch = (p: Partial<ConnectionInput>) => {
    setForm((f) => ({ ...f, ...p }));
    setTestResult(null);
  };

  const onPasteUrl = (raw: string) => {
    setUrlInput(raw);
    if (!raw.trim()) return setUrlError(null);
    const parsed = parseConnectionUrl(raw);
    if (!parsed) return setUrlError("Unrecognised URL — expected postgres:// mysql:// mongodb:// redis:// mssql:// oracle:// clickhouse://");
    setUrlError(null);
    patch({
      name: form.name || `${parsed.kind}@${parsed.host}`,
      kind: parsed.kind,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username ?? "",
      password: parsed.password ?? "",
      database: parsed.database ?? "",
      options: parsed.options,
    });
  };

  const setKind = (kind: DbKind) => patch({ kind, port: KIND_LABEL[kind].port });

  function sanitizePatch(input: ConnectionInput): Partial<ConnectionInput> {
    const out: Partial<ConnectionInput> = normalize(input);
    if (!input.password) delete out.password;
    return out;
  }

  return (
    <Modal title={editing ? `Edit connection · ${editing.name}` : "New connection"} onClose={onClose} width={560}>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(normalize(form));
        }}
      >
        <label>
          <span>Paste a connection URL (optional)</span>
          <textarea
            rows={2}
            value={urlInput}
            onChange={(e) => onPasteUrl(e.target.value)}
            placeholder="postgres://user:pass@host:5432/db  ·  DATABASE_URL=mongodb://…  ·  mysql://…"
            spellCheck={false}
          />
          {urlError && <span className="error small">{urlError}</span>}
        </label>

        <div className="row">
          <label className="grow">
            <span>Name</span>
            <input ref={nameRef} required value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="prod-mysql" />
          </label>
          <label>
            <span>Engine</span>
            <select value={form.kind} onChange={(e) => setKind(e.target.value as DbKind)}>
              {KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k].label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row">
          <label className="grow">
            <span>Host</span>
            <input required value={form.host} onChange={(e) => patch({ host: e.target.value })} spellCheck={false} />
          </label>
          <label style={{ width: 110 }}>
            <span>Port</span>
            <input required type="number" value={form.port} onChange={(e) => patch({ port: Number(e.target.value) })} />
          </label>
        </div>

        <div className="row">
          <label className="grow">
            <span>Username</span>
            <input value={form.username ?? ""} onChange={(e) => patch({ username: e.target.value })} autoComplete="off" spellCheck={false} />
          </label>
          <label className="grow">
            <span>Password{editing && <span className="muted"> (blank = keep)</span>}</span>
            <div className="input-with-btn">
              <input
                type={showPassword ? "text" : "password"}
                value={form.password ?? ""}
                onChange={(e) => patch({ password: e.target.value })}
                autoComplete="new-password"
              />
              <button type="button" className="ghost icon-btn" onClick={() => setShowPassword((v) => !v)} title={showPassword ? "Hide" : "Show"}>
                {showPassword ? "🙈" : "👁"}
              </button>
            </div>
          </label>
        </div>

        <div className="row">
          <label className="grow">
            <span>Database (optional)</span>
            <input value={form.database ?? ""} onChange={(e) => patch({ database: e.target.value })} placeholder="choose later from the tree" spellCheck={false} />
          </label>
          <label className="grow">
            <span>Group (optional)</span>
            <input list="dbweb-groups" value={form.group ?? ""} onChange={(e) => patch({ group: e.target.value })} placeholder="Coolify, Production…" />
            <datalist id="dbweb-groups">
              {groupNames.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        </div>

        <label>
          <span>Environment color — a stripe in the sidebar and workbench so prod is unmistakable</span>
          <div className="color-picks" role="radiogroup">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={(form.color ?? "") === c.value}
                className={`color-pick ${c.value ? `env-${c.value}` : "env-none"} ${(form.color ?? "") === c.value ? "active" : ""}`}
                onClick={() => patch({ color: c.value || null })}
                title={c.label}
              >
                <span className="swatch" />
                {c.label}
              </button>
            ))}
          </div>
        </label>

        <div className="row" style={{ alignItems: "center", gap: 18 }}>
          <label className="inline" style={{ color: "var(--text)" }} title="Blocks INSERT/UPDATE/DELETE/DDL, row edits, imports and restores on the server side">
            <input type="checkbox" checked={!!form.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} /> 🔒 Read-only connection
          </label>
          <label className="inline" style={{ color: "var(--text)" }}>
            <input
              type="checkbox"
              checked={sshOpen}
              onChange={(e) => {
                setSshOpen(e.target.checked);
                if (!e.target.checked) patch({ ssh: null });
                else if (!form.ssh) patch({ ssh: { host: "", port: 22, username: "" } });
              }}
            />{" "}
            ⇄ Connect through SSH tunnel
          </label>
        </div>

        {sshOpen && (
          <fieldset className="ssh-box">
            <legend>SSH jump host {editing?.ssh?.hasSecret && <span className="muted">(secret stored — leave blank to keep)</span>}</legend>
            <div className="row">
              <label className="grow">
                <span>SSH host</span>
                <input value={form.ssh?.host ?? ""} onChange={(e) => patch({ ssh: { ...form.ssh!, host: e.target.value } })} placeholder="bastion.example.com" spellCheck={false} />
              </label>
              <label style={{ width: 90 }}>
                <span>Port</span>
                <input type="number" value={form.ssh?.port ?? 22} onChange={(e) => patch({ ssh: { ...form.ssh!, port: Number(e.target.value) || 22 } })} />
              </label>
              <label className="grow">
                <span>SSH user</span>
                <input value={form.ssh?.username ?? ""} onChange={(e) => patch({ ssh: { ...form.ssh!, username: e.target.value } })} placeholder="ubuntu" spellCheck={false} />
              </label>
            </div>
            <div className="row">
              <label style={{ width: 140 }}>
                <span>Auth</span>
                <select value={sshAuth} onChange={(e) => setSshAuth(e.target.value as "password" | "key")}>
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                </select>
              </label>
              {sshAuth === "password" ? (
                <label className="grow">
                  <span>SSH password</span>
                  <input type="password" value={form.ssh?.password ?? ""} onChange={(e) => patch({ ssh: { ...form.ssh!, password: e.target.value } })} autoComplete="new-password" />
                </label>
              ) : (
                <>
                  <label className="grow">
                    <span>Key file path or PEM contents</span>
                    <input value={form.ssh?.privateKey ?? ""} onChange={(e) => patch({ ssh: { ...form.ssh!, privateKey: e.target.value } })} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
                  </label>
                  <label style={{ width: 150 }}>
                    <span>Key passphrase</span>
                    <input type="password" value={form.ssh?.passphrase ?? ""} onChange={(e) => patch({ ssh: { ...form.ssh!, passphrase: e.target.value } })} autoComplete="new-password" />
                  </label>
                </>
              )}
            </div>
            <span className="muted hint">The database host/port above are resolved from the SSH server, so use the internal address (often 127.0.0.1).</span>
          </fieldset>
        )}

        {form.host && (
          <div className="url-preview">
            <span className="muted small">Equivalent URL</span>
            <div className="row-tight">
              <code className="url-code">{buildConnectionUrl(form)}</code>
              <button type="button" className="ghost icon-btn" onClick={() => void copyText(buildConnectionUrl(form), "URL copied")} title="Copy">
                ⧉
              </button>
            </div>
          </div>
        )}

        {testResult && (
          <div className={`banner ${testResult.ok ? "ok-banner" : "error-banner"}`}>
            {testResult.ok ? (
              <>
                ✓ Connected · {testResult.ping.latencyMs}ms · {shortVersion(testResult.ping.serverVersion)}
              </>
            ) : (
              <>✕ {testResult.message}</>
            )}
          </div>
        )}
        {save.isError && <div className="error">{(save.error as Error).message}</div>}

        <div className="modal-footer">
          <button type="button" className="ghost" onClick={() => test.mutate()} disabled={test.isPending || !form.host}>
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          <div className="grow" />
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Blank optional strings → undefined so the API doesn't store "". */
function normalize(input: ConnectionInput): ConnectionInput {
  return {
    ...input,
    username: input.username || undefined,
    database: input.database || undefined,
    group: input.group?.trim() ? input.group.trim() : null,
    color: input.color ?? null,
    readOnly: !!input.readOnly,
    ssh: input.ssh?.host ? { ...input.ssh, port: input.ssh.port || 22 } : null,
  };
}
