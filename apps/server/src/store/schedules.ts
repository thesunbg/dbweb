import { nanoid } from "nanoid";
import type { AlertCondition, AlertDto, ScheduleDto } from "@dbweb/shared-types";
import { getDb } from "./sqlite.js";

interface Row {
  id: string;
  connection_id: string;
  database_name: string | null;
  name: string;
  statement: string;
  interval_min: number;
  cron: string | null;
  condition_json: string;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
  created_at: string;
}

const toDto = (r: Row): ScheduleDto => ({
  id: r.id,
  connectionId: r.connection_id,
  database: r.database_name ?? undefined,
  name: r.name,
  statement: r.statement,
  intervalMin: r.interval_min,
  cron: r.cron,
  condition: JSON.parse(r.condition_json) as AlertCondition,
  enabled: r.enabled === 1,
  lastRunAt: r.last_run_at,
  lastStatus: (r.last_status as ScheduleDto["lastStatus"]) ?? null,
  lastMessage: r.last_message,
  createdAt: r.created_at,
});

export type ScheduleInput = Omit<ScheduleDto, "id" | "createdAt" | "lastRunAt" | "lastStatus" | "lastMessage">;

export function listSchedules(connectionId?: string): ScheduleDto[] {
  const db = getDb();
  const rows = connectionId
    ? db.prepare<[string], Row>("SELECT * FROM schedules WHERE connection_id = ? ORDER BY name").all(connectionId)
    : db.prepare<[], Row>("SELECT * FROM schedules ORDER BY name").all();
  return rows.map(toDto);
}

export function getSchedule(id: string): ScheduleDto | null {
  const row = getDb().prepare<[string], Row>("SELECT * FROM schedules WHERE id = ?").get(id);
  return row ? toDto(row) : null;
}

export function createSchedule(input: ScheduleInput): ScheduleDto {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO schedules (id, connection_id, database_name, name, statement, interval_min, cron, condition_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.connectionId, input.database ?? null, input.name, input.statement, input.intervalMin, input.cron ?? null, JSON.stringify(input.condition), input.enabled ? 1 : 0, createdAt);
  return getSchedule(id)!;
}

export function updateSchedule(id: string, patch: Partial<ScheduleInput>): ScheduleDto | null {
  const existing = getSchedule(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  getDb()
    .prepare(
      `UPDATE schedules SET connection_id = ?, database_name = ?, name = ?, statement = ?, interval_min = ?, cron = ?, condition_json = ?, enabled = ? WHERE id = ?`,
    )
    .run(merged.connectionId, merged.database ?? null, merged.name, merged.statement, merged.intervalMin, merged.cron ?? null, JSON.stringify(merged.condition), merged.enabled ? 1 : 0, id);
  return getSchedule(id);
}

export function recordScheduleRun(id: string, status: "ok" | "error" | "alert", message: string): void {
  getDb()
    .prepare("UPDATE schedules SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?")
    .run(new Date().toISOString(), status, message.slice(0, 500), id);
}

export function deleteSchedule(id: string): boolean {
  return getDb().prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
}

interface AlertRow {
  id: string;
  schedule_id: string;
  schedule_name: string;
  connection_id: string;
  message: string;
  created_at: string;
  read: number;
}

const toAlert = (r: AlertRow): AlertDto => ({
  id: r.id,
  scheduleId: r.schedule_id,
  scheduleName: r.schedule_name,
  connectionId: r.connection_id,
  message: r.message,
  createdAt: r.created_at,
  read: r.read === 1,
});

export function createAlert(schedule: ScheduleDto, message: string): AlertDto {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO alerts (id, schedule_id, schedule_name, connection_id, message, created_at, read) VALUES (?, ?, ?, ?, ?, ?, 0)")
    .run(id, schedule.id, schedule.name, schedule.connectionId, message.slice(0, 1000), createdAt);
  return { id, scheduleId: schedule.id, scheduleName: schedule.name, connectionId: schedule.connectionId, message, createdAt, read: false };
}

export function listAlerts(limit = 100): AlertDto[] {
  return getDb().prepare<[number], AlertRow>("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?").all(limit).map(toAlert);
}

export function markAlertsRead(ids?: string[]): void {
  const db = getDb();
  if (!ids) {
    db.prepare("UPDATE alerts SET read = 1").run();
    return;
  }
  const stmt = db.prepare("UPDATE alerts SET read = 1 WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

export function clearAlerts(): void {
  getDb().prepare("DELETE FROM alerts").run();
}
