import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

/** Status-bar bell: unread alerts from scheduled queries. */
export function AlertsPopover({ onSelectConnection }: { onSelectConnection: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: api.listAlerts, refetchInterval: 20_000 });
  const unread = alerts.data?.filter((a) => !a.read) ?? [];

  const markRead = useMutation({
    mutationFn: () => api.markAlertsRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAlerts(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="alerts-wrap" ref={ref}>
      <button type="button" className={`statusbar-btn ${unread.length ? "has-alerts" : ""}`} onClick={() => setOpen((o) => !o)} title="Alerts from scheduled queries">
        🔔 {unread.length > 0 ? unread.length : "Alerts"}
      </button>
      {open && (
        <div className="alerts-pop">
          <div className="alerts-head">
            <strong>Alerts</strong>
            <div className="grow" />
            {unread.length > 0 && (
              <button type="button" className="ghost tiny" onClick={() => markRead.mutate()}>
                Mark all read
              </button>
            )}
            {(alerts.data?.length ?? 0) > 0 && (
              <button type="button" className="ghost tiny" onClick={() => clear.mutate()}>
                Clear
              </button>
            )}
          </div>
          {alerts.data?.length === 0 && <div className="muted hint" style={{ padding: 10 }}>No alerts. Create one under Tools → Scheduled queries.</div>}
          <ul className="alerts-list">
            {alerts.data?.map((a) => (
              <li key={a.id} className={`alert-item ${a.read ? "" : "unread"}`} onClick={() => onSelectConnection(a.connectionId)}>
                <div className="alert-title">{a.scheduleName}</div>
                <div className="alert-msg">{a.message}</div>
                <div className="muted hint">{new Date(a.createdAt).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
