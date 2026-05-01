import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectionConfig } from "@dbweb/shared-types";
import { api } from "../api.js";

interface Props {
  connection: ConnectionConfig;
  database?: string;
}

export function Stats({ connection, database }: Props) {
  const stats = useQuery({
    queryKey: ["stats", connection.id, database],
    queryFn: () => api.stats(connection.id, database),
  });
  const history = useQuery({
    queryKey: ["history-stats", connection.id],
    queryFn: () => api.history(connection.id),
  });

  const summary = useMemo(() => {
    const items = history.data ?? [];
    const total = items.length;
    const errors = items.filter((h) => h.error).length;
    const avg = total > 0 ? Math.round(items.reduce((s, h) => s + h.elapsedMs, 0) / total) : 0;
    const slow = [...items].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5);
    return { total, errors, avg, slow };
  }, [history.data]);

  const buckets = useMemo(() => {
    const items = history.data ?? [];
    const map = new Map<string, number>();
    for (const it of items) {
      const day = it.createdAt.slice(0, 10);
      map.set(day, (map.get(day) ?? 0) + 1);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14);
  }, [history.data]);

  const max = Math.max(1, ...buckets.map(([, n]) => n));
  const tableSizes = useMemo(() => {
    if (!stats.data?.rowEstimates) return [];
    return Object.entries(stats.data.rowEstimates)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);
  }, [stats.data]);

  return (
    <div className="stats">
      <div className="stats-grid">
        <Card label="Database size" value={fmtBytes(stats.data?.sizeBytes)} />
        <Card label="Tables / collections" value={stats.data?.tableCount?.toString() ?? "—"} />
        <Card label="Queries logged" value={summary.total.toString()} />
        <Card
          label="Avg latency"
          value={summary.avg ? `${summary.avg} ms` : "—"}
          sub={summary.errors > 0 ? `${summary.errors} errored` : "0 errored"}
        />
      </div>

      <section className="stats-section">
        <h4>Queries / day (last 14)</h4>
        <div className="bar-chart">
          {buckets.length === 0 && <div className="muted">No history yet.</div>}
          {buckets.map(([day, n]) => (
            <div key={day} className="bar-col" title={`${day}: ${n}`}>
              <div className="bar" style={{ height: `${(n / max) * 100}%` }} />
              <div className="bar-label">{day.slice(5)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="stats-section">
        <h4>Top 5 slowest queries</h4>
        {summary.slow.length === 0 && <div className="muted">No queries yet.</div>}
        <table className="result-table compact">
          <thead>
            <tr>
              <th>elapsed</th>
              <th>rows</th>
              <th>statement</th>
              <th>at</th>
            </tr>
          </thead>
          <tbody>
            {summary.slow.map((h) => (
              <tr key={h.id}>
                <td>{h.elapsedMs} ms</td>
                <td>{h.rowCount}</td>
                <td className="truncated"><code>{h.statement}</code></td>
                <td>{h.createdAt.slice(0, 19).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {tableSizes.length > 0 && (
        <section className="stats-section">
          <h4>Top 10 largest tables (by row estimate)</h4>
          <table className="result-table compact">
            <thead>
              <tr>
                <th>table</th>
                <th>rows (est.)</th>
              </tr>
            </thead>
            <tbody>
              {tableSizes.map(([name, n]) => (
                <tr key={name}>
                  <td><code>{name}</code></td>
                  <td>{n.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function fmtBytes(n?: number): string {
  if (n === undefined || n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
