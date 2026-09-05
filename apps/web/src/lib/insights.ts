import type { DbKind } from "@dbweb/shared-types";

export interface Insight {
  title: string;
  statement: string;
  note?: string;
}

/**
 * Server-side performance views per engine — shown on the Stats tab. Each
 * is best-effort: when the extension / privilege is missing the section
 * just says so.
 */
export const SERVER_INSIGHTS: Record<DbKind, Insight[]> = {
  postgres: [
    {
      title: "Slowest statements (pg_stat_statements)",
      note: "Requires the pg_stat_statements extension. Times in ms.",
      statement: `SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms, round(total_exec_time::numeric) AS total_ms, rows, left(query, 160) AS query
FROM pg_stat_statements
WHERE query NOT ILIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC
LIMIT 20`,
    },
    {
      title: "Active sessions",
      statement: `SELECT pid, usename, datname, state, wait_event_type, round(extract(epoch FROM now() - query_start)) AS running_s, left(query, 120) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid()
ORDER BY query_start`,
    },
    {
      title: "Tables with most sequential scans",
      statement: `SELECT schemaname || '.' || relname AS table, seq_scan, idx_scan, n_live_tup AS rows_est, n_dead_tup AS dead_rows
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 15`,
    },
  ],
  mysql: [
    {
      title: "Slowest statements (performance_schema)",
      note: "Digest summary since the last restart. Times in ms.",
      statement: `SELECT COUNT_STAR AS calls, ROUND(AVG_TIMER_WAIT / 1e9, 1) AS avg_ms, ROUND(SUM_TIMER_WAIT / 1e9) AS total_ms, SUM_ROWS_EXAMINED AS rows_examined, LEFT(DIGEST_TEXT, 160) AS query
FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST_TEXT IS NOT NULL
ORDER BY AVG_TIMER_WAIT DESC
LIMIT 20`,
    },
    {
      title: "Active sessions",
      statement: `SELECT ID AS id, USER AS user, DB AS db, COMMAND AS command, TIME AS seconds, STATE AS state, LEFT(INFO, 120) AS query
FROM information_schema.PROCESSLIST
WHERE COMMAND <> 'Sleep'
ORDER BY TIME DESC`,
    },
    {
      title: "Largest tables",
      statement: `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS table_name, TABLE_ROWS AS rows_est, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1048576, 1) AS size_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema')
ORDER BY DATA_LENGTH + INDEX_LENGTH DESC
LIMIT 15`,
    },
  ],
  mssql: [
    {
      title: "Slowest statements (dm_exec_query_stats)",
      statement: `SELECT TOP 20 qs.execution_count AS calls, qs.total_elapsed_time / qs.execution_count / 1000 AS avg_ms, qs.total_elapsed_time / 1000 AS total_ms,
  LEFT(SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 160), 160) AS query
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
ORDER BY qs.total_elapsed_time / qs.execution_count DESC`,
    },
    {
      title: "Active requests",
      statement: `SELECT r.session_id, r.status, r.command, r.wait_type, r.total_elapsed_time / 1000 AS seconds, LEFT(t.text, 120) AS query
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id <> @@SPID`,
    },
  ],
  clickhouse: [
    {
      title: "Slowest queries (last 24h, system.query_log)",
      statement: `SELECT count() AS calls, round(avg(query_duration_ms)) AS avg_ms, max(query_duration_ms) AS max_ms, formatReadableSize(sum(read_bytes)) AS read, left(normalizeQuery(query), 160) AS query
FROM system.query_log
WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY AND query NOT ILIKE '%system.query_log%'
GROUP BY normalizeQuery(query)
ORDER BY avg_ms DESC
LIMIT 20`,
    },
    {
      title: "Running queries",
      statement: `SELECT query_id, user, round(elapsed, 1) AS seconds, read_rows, formatReadableSize(memory_usage) AS memory, left(query, 120) AS query FROM system.processes`,
    },
  ],
  oracle: [
    {
      title: "Slowest statements (v$sql)",
      statement: `SELECT * FROM (
  SELECT executions AS calls, ROUND(elapsed_time / GREATEST(executions, 1) / 1000) AS avg_ms, ROUND(elapsed_time / 1000) AS total_ms, SUBSTR(sql_text, 1, 160) AS query
  FROM v$sql WHERE executions > 0 ORDER BY elapsed_time / GREATEST(executions, 1) DESC
) WHERE ROWNUM <= 20`,
    },
    {
      title: "Active sessions",
      statement: `SELECT sid, username, status, event, seconds_in_wait, SUBSTR(sql_id, 1, 20) AS sql_id FROM v$session WHERE status = 'ACTIVE' AND username IS NOT NULL`,
    },
  ],
  mongodb: [
    { title: "Current operations", note: "Long-running or active operations right now.", statement: "db.currentOp({ active: true, secs_running: { $gt: 0 } })" },
    { title: "Server status · connections & opcounters", statement: "db.serverStatus()" },
  ],
  redis: [
    { title: "Slow log (last 20)", statement: "SLOWLOG GET 20" },
    { title: "Memory", statement: "INFO memory" },
    { title: "Clients", statement: "CLIENT LIST" },
  ],
  dragonfly: [
    { title: "Slow log (last 20)", statement: "SLOWLOG GET 20" },
    { title: "Memory", statement: "INFO memory" },
  ],
};
