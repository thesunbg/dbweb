import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";
import { Modal, confirmDialog, toast } from "../lib/ui.js";

interface Props {
  connection: ConnectionConfig;
  database?: string;
  onClose: () => void;
}

/** pg_dump / mysqldump / mongodump wrappers with a job log. */
export function BackupsModal({ connection, database, onClose }: Props) {
  const qc = useQueryClient();
  const [db, setDb] = useState(database ?? connection.database ?? "");
  const [openLog, setOpenLog] = useState<string | null>(null);
  const tools = useQuery({ queryKey: ["backup-tools", connection.id], queryFn: () => api.backupTools(connection.id) });
  const dbs = useQuery({ queryKey: ["dbs", connection.id], queryFn: () => api.listDatabases(connection.id) });
  const list = useQuery({
    queryKey: ["backups", connection.id],
    queryFn: () => api.listBackups(connection.id),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "running") ? 1500 : 10_000),
  });

  const backup = useMutation({
    mutationFn: () => api.startBackup(connection.id, db),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups", connection.id] });
      toast.info(`Backup of ${db} started`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const restore = useMutation({
    mutationFn: (file: string) => api.startRestore(connection.id, db, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups", connection.id] });
      toast.info(`Restore into ${db} started`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (file: string) => api.deleteBackup(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backups", connection.id] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const t = tools.data;
  const canBackup = t?.supported && t.backup?.available;
  const canRestore = t?.supported && t.restore?.available && !connection.readOnly;

  return (
    <Modal title={`Backups · ${connection.name}`} onClose={onClose} width={760}>
      {tools.isSuccess && !t?.supported && <div className="banner error-banner">Backup via CLI tools is only wired up for PostgreSQL, MySQL and MongoDB.</div>}
      {t?.supported && (!t.backup?.available || !t.restore?.available) && (
        <div className="banner error-banner">
          Missing on this Mac: {[!t.backup?.available && t.backup?.tool, !t.restore?.available && t.restore?.tool].filter(Boolean).join(", ")}. Install the client tools (e.g. <code>brew install libpq mysql-client mongodb-database-tools</code>) and make sure they are in PATH.
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="grow">
          <span>Database</span>
          <input list="backup-dbs" value={db} onChange={(e) => setDb(e.target.value)} />
          <datalist id="backup-dbs">
            {dbs.data?.map((d) => (
              <option key={d.name} value={d.name} />
            ))}
          </datalist>
        </label>
        <button type="button" className="primary" disabled={!canBackup || !db || backup.isPending} onClick={() => backup.mutate()}>
          ↓ Back up now
        </button>
      </div>
      <p className="muted hint">Files are written to ~/.dbweb/backups. Restore replaces objects in the chosen database (pg_restore --clean, mongorestore --drop).</p>

      {list.data && list.data.jobs.length > 0 && (
        <section>
          <h4 className="section-title">Jobs</h4>
          <ul className="snippet-list">
            {list.data.jobs.map((j) => (
              <li key={j.id} className="snippet-item">
                <div className="snippet-head">
                  <span className={`status-dot ${j.status === "running" ? "pending" : j.status === "done" ? "ok" : "down"}`} />
                  <strong>{j.kind}</strong>
                  <span className="muted hint">
                    {j.database} · {j.file} · {new Date(j.startedAt).toLocaleTimeString()} · {j.status}
                  </span>
                  <div className="grow" />
                  <button type="button" className="ghost tiny" onClick={() => setOpenLog(openLog === j.id ? null : j.id)}>
                    {openLog === j.id ? "Hide log" : "Log"}
                  </button>
                </div>
                {openLog === j.id && <pre className="snippet-code">{j.log || "(no output yet)"}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className="section-title">Backup files</h4>
        {list.data?.files.length === 0 && <div className="muted hint">No backups for this connection yet.</div>}
        <ul className="snippet-list">
          {list.data?.files.map((f) => (
            <li key={f.file} className="snippet-item">
              <div className="snippet-head">
                <strong>{f.file}</strong>
                <span className="muted hint">
                  {fmtBytes(f.sizeBytes)} · {new Date(f.createdAt).toLocaleString()}
                </span>
                <div className="grow" />
                <button
                  type="button"
                  className="ghost tiny"
                  disabled={!canRestore || !db || restore.isPending}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: `Restore into "${db}"?`,
                      message: `Existing objects in ${db} will be replaced with the contents of ${f.file}. Make sure this is the right connection.`,
                      danger: true,
                      confirmLabel: "Restore",
                    });
                    if (ok) restore.mutate(f.file);
                  }}
                >
                  ↑ Restore into {db || "…"}
                </button>
                <button
                  type="button"
                  className="ghost icon-btn danger"
                  onClick={async () => {
                    if (await confirmDialog({ title: `Delete ${f.file}?`, danger: true, confirmLabel: "Delete" })) remove.mutate(f.file);
                  }}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Modal>
  );
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
