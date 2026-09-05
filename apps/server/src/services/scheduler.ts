import { spawn } from "node:child_process";
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";
import type { AlertCondition, CompareOp, ScheduleDto } from "@dbweb/shared-types";
import { getAdapter, touchAdapter } from "./adapter-pool.js";
import { createAlert, listSchedules, recordScheduleRun } from "../store/schedules.js";

/**
 * Runs enabled schedules in-process. A 30s tick checks which ones are due
 * (interval or cron), executes the statement, evaluates the alert condition
 * and — when it fires — stores an alert and pops a macOS notification.
 */
let timer: NodeJS.Timeout | null = null;
const running = new Set<string>();
let log: FastifyBaseLogger | null = null;

export function startScheduler(logger: FastifyBaseLogger): void {
  log = logger;
  if (timer) return;
  timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  void tick();
}

/** True while at least one enabled schedule exists — the idle-exit timer
 *  checks this so a monitoring setup doesn't kill its own server. */
export function hasActiveSchedules(): boolean {
  return listSchedules().some((s) => s.enabled);
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const s of listSchedules()) {
    if (!s.enabled || running.has(s.id)) continue;
    if (!isDue(s, now)) continue;
    running.add(s.id);
    void runSchedule(s).finally(() => running.delete(s.id));
  }
}

function isDue(s: ScheduleDto, now: number): boolean {
  const last = s.lastRunAt ? Date.parse(s.lastRunAt) : 0;
  if (s.cron) {
    try {
      const next = new Cron(s.cron).nextRun(new Date(last || now - 1));
      return !!next && next.getTime() <= now;
    } catch {
      return false;
    }
  }
  return now - last >= Math.max(1, s.intervalMin) * 60_000;
}

export async function runSchedule(s: ScheduleDto): Promise<{ status: "ok" | "error" | "alert"; message: string }> {
  try {
    const adapter = await getAdapter(s.connectionId);
    const res = await adapter.execute(s.statement, { maxRows: 1000, database: s.database });
    touchAdapter(s.connectionId);
    const first = res.rows[0]?.[0];
    const firstNum = typeof first === "number" ? first : Number(first);
    const fired = evaluate(s.condition, res.rowCount, Number.isFinite(firstNum) ? firstNum : null, false);
    const message = fired
      ? `${s.name}: ${describe(s.condition)} — ${res.rowCount} row${res.rowCount === 1 ? "" : "s"}${Number.isFinite(firstNum) ? `, first value ${firstNum}` : ""}`
      : `${res.rowCount} rows · ${res.elapsedMs}ms`;
    recordScheduleRun(s.id, fired ? "alert" : "ok", message);
    if (fired) {
      createAlert(s, message);
      notify("dbweb alert", message);
    }
    return { status: fired ? "alert" : "ok", message };
  } catch (err) {
    const message = (err as Error).message;
    const fired = s.condition.type === "error";
    recordScheduleRun(s.id, "error", message);
    if (fired) {
      createAlert(s, `${s.name} failed: ${message}`);
      notify("dbweb alert", `${s.name} failed: ${message}`);
    }
    log?.warn(`schedule ${s.name} failed: ${message}`);
    return { status: "error", message };
  }
}

function evaluate(c: AlertCondition, rows: number, value: number | null, errored: boolean): boolean {
  switch (c.type) {
    case "always":
      return true;
    case "error":
      return errored;
    case "rows":
      return compare(rows, c.op, c.value);
    case "value":
      return value !== null && compare(value, c.op, c.value);
  }
}

function compare(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "=": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    default: return false;
  }
}

function describe(c: AlertCondition): string {
  if (c.type === "always") return "ran";
  if (c.type === "error") return "errored";
  return `${c.type} ${c.op} ${c.value}`;
}

/** macOS notification center via osascript; silently no-op elsewhere. */
function notify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const child = spawn("osascript", ["-e", `display notification "${esc(body.slice(0, 200))}" with title "${esc(title)}"`], { stdio: "ignore" });
  child.on("error", () => undefined);
}
