import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AlertCondition, CompareOp, ConnectionConfig, ScheduleDto } from "@dbweb/shared-types";
import { api, type ScheduleInput } from "../api.js";
import { Modal, confirmDialog, toast } from "../lib/ui.js";

interface Props {
  connection: ConnectionConfig;
  database?: string;
  initialStatement?: string;
  onClose: () => void;
}

const OPS: CompareOp[] = [">", ">=", "=", "!=", "<", "<="];

/**
 * Scheduled queries + alert conditions for one connection. The server runs
 * them even while the window is closed (the idle-exit is suppressed while a
 * schedule is enabled) and raises a macOS notification when one fires.
 */
export function SchedulesModal({ connection, database, initialStatement, onClose }: Props) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules", connection.id], queryFn: () => api.listSchedules(connection.id), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<Partial<ScheduleInput> & { id?: string } | null>(
    initialStatement ? blank(connection.id, database, initialStatement) : null,
  );

  const save = useMutation({
    mutationFn: (s: Partial<ScheduleInput> & { id?: string }) => {
      const body: ScheduleInput = {
        connectionId: connection.id,
        database: s.database || undefined,
        name: s.name!,
        statement: s.statement!,
        intervalMin: s.intervalMin ?? 60,
        cron: s.cron?.trim() || null,
        condition: s.condition ?? { type: "always" },
        enabled: s.enabled ?? true,
      };
      return s.id ? api.updateSchedule(s.id, body) : api.createSchedule(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      setEditing(null);
      toast.success("Schedule saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const toggle = useMutation({
    mutationFn: (s: ScheduleDto) => api.updateSchedule(s.id, { enabled: !s.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api.runSchedule(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
      (r.status === "error" ? toast.error : r.status === "alert" ? toast.info : toast.success)(r.message);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Modal title={`Scheduled queries · ${connection.name}`} onClose={onClose} width={760}>
      {editing ? (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(editing);
          }}
        >
          <div className="row">
            <label className="grow">
              <span>Name</span>
              <input required value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus placeholder="Failed orders in the last hour" />
            </label>
            <label style={{ width: 160 }}>
              <span>Database</span>
              <input value={editing.database ?? ""} onChange={(e) => setEditing({ ...editing, database: e.target.value })} placeholder="(default)" />
            </label>
          </div>
          <label>
            <span>Statement</span>
            <textarea required rows={5} value={editing.statement ?? ""} onChange={(e) => setEditing({ ...editing, statement: e.target.value })} spellCheck={false} />
          </label>
          <div className="row">
            <label style={{ width: 160 }}>
              <span>Every (minutes)</span>
              <input type="number" min={1} value={editing.intervalMin ?? 60} onChange={(e) => setEditing({ ...editing, intervalMin: Math.max(1, Number(e.target.value)) })} />
            </label>
            <label className="grow">
              <span>…or cron expression (overrides the interval)</span>
              <input value={editing.cron ?? ""} onChange={(e) => setEditing({ ...editing, cron: e.target.value })} placeholder="0 8 * * 1-5   (08:00 on weekdays)" spellCheck={false} />
            </label>
          </div>
          <ConditionEditor value={editing.condition ?? { type: "always" }} onChange={(condition) => setEditing({ ...editing, condition })} />
          <label className="inline">
            <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Enabled
          </label>
          <div className="modal-footer">
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              Back
            </button>
            <button type="submit" className="primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save schedule"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="row-tight" style={{ justifyContent: "space-between" }}>
            <span className="muted hint">Alerts show in the status bar bell and as macOS notifications. The server stays up while a schedule is enabled.</span>
            <button type="button" className="primary" onClick={() => setEditing(blank(connection.id, database))}>
              + New schedule
            </button>
          </div>
          {list.data?.length === 0 && <div className="muted hint">No schedules for this connection yet.</div>}
          <ul className="snippet-list">
            {list.data?.map((s) => (
              <li key={s.id} className={`snippet-item ${s.enabled ? "" : "disabled"}`}>
                <div className="snippet-head">
                  <span className={`status-dot ${s.lastStatus === "error" ? "down" : s.lastStatus === "alert" ? "pending" : s.enabled ? "ok" : ""}`} />
                  <strong>{s.name}</strong>
                  <span className="muted hint">
                    {s.cron ? `cron ${s.cron}` : `every ${s.intervalMin} min`} · {describe(s.condition)}
                    {s.database ? ` · ${s.database}` : ""}
                  </span>
                  <div className="grow" />
                  <button type="button" className="ghost tiny" onClick={() => runNow.mutate(s.id)} disabled={runNow.isPending}>
                    ▶ Run now
                  </button>
                  <button type="button" className="ghost tiny" onClick={() => toggle.mutate(s)}>
                    {s.enabled ? "Pause" : "Enable"}
                  </button>
                  <button type="button" className="ghost tiny" onClick={() => setEditing({ ...s })}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn danger"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Delete schedule "${s.name}"?`, danger: true, confirmLabel: "Delete" })) remove.mutate(s.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                <pre className="snippet-code">{s.statement}</pre>
                {s.lastRunAt && (
                  <div className={`hint ${s.lastStatus === "error" ? "error" : "muted"}`}>
                    last run {new Date(s.lastRunAt).toLocaleString()} · {s.lastStatus} · {s.lastMessage}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

function blank(connectionId: string, database?: string, statement = ""): Partial<ScheduleInput> {
  return { connectionId, database, statement, intervalMin: 60, condition: { type: "rows", op: ">", value: 0 }, enabled: true };
}

function describe(c: AlertCondition): string {
  if (c.type === "always") return "alert every run";
  if (c.type === "error") return "alert on error";
  return `alert when ${c.type === "rows" ? "row count" : "first value"} ${c.op} ${c.value}`;
}

function ConditionEditor({ value, onChange }: { value: AlertCondition; onChange: (c: AlertCondition) => void }) {
  const hasOp = value.type === "rows" || value.type === "value";
  return (
    <label>
      <span>Alert when</span>
      <div className="row-tight" style={{ gap: 6 }}>
        <select
          value={value.type}
          onChange={(e) => {
            const type = e.target.value as AlertCondition["type"];
            if (type === "always" || type === "error") onChange({ type });
            else onChange({ type, op: hasOp ? value.op : ">", value: hasOp ? value.value : 0 });
          }}
        >
          <option value="rows">row count</option>
          <option value="value">first cell value</option>
          <option value="error">the query fails</option>
          <option value="always">every run (just log it)</option>
        </select>
        {hasOp && (
          <>
            <select value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as CompareOp })}>
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <input type="number" style={{ width: 120 }} value={value.value} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })} />
          </>
        )}
      </div>
    </label>
  );
}
